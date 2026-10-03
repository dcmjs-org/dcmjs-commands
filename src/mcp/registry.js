// src/mcp/registry.js
//
// The MCP tool table: name -> { title, description, inputSchema, handler }.
// This is the testable core — handlers are plain async functions taking
// ({ dcmjs, args }) and returning the structuredContent object, no server
// or transport involved. src/mcp/server.js registers these on an McpServer.
//
// Design rules (the "help the LLM make the correct choice" contract):
//  - Descriptions are written for LLM consumption: they state defaults and
//    conformance behavior, not just what the tool does.
//  - Binary results are file paths ({ written }), never inline bytes; a
//    missing output path is a corrective error naming the parameter.
//  - Warnings from the underlying command are returned in `warnings`, so
//    partial success is visible, not silent.
//  - Destructive or derived operations offer dry_run.

import { z } from "zod";
import { runDump } from "../commands/dump.js";
import { runInstance } from "../commands/instance.js";
import { validateFiles } from "../commands/validate.js";
import { runConvert } from "../commands/convert.js";
import { runAnonymize } from "../commands/anonymize.js";
import { runFilter } from "../commands/filter.js";
import { runDicomdir } from "../commands/dicomdir.js";
import { runDicomweb } from "../commands/dicomweb.js";
import { runCaptured, commandError } from "./capture.js";

const TAG = z
  .string()
  .regex(/^[0-9A-Fa-f]{8}$/, "an 8-hex-digit DICOM tag like 00100010");

function ok(extra, { stderrLines } = { stderrLines: [] }) {
  return { ok: true, warnings: stderrLines.filter(Boolean), ...extra };
}

export const TOOLS = {
  dicom_dump: {
    title: "Dump a DICOM file",
    description:
      "Read a local DICOM (Part 10) file and return its dataset. " +
      "format 'json' (default) returns the naturalized dataset as an object " +
      "(binary values summarized); format 'lines' returns the classic " +
      "one-line-per-element listing. Reads any transfer syntax the dcmjs " +
      "parser understands; DICOMDIR files are DICOM files and dump fine.",
    inputSchema: {
      file: z.string().describe("path to the DICOM file"),
      format: z.enum(["json", "lines"]).optional(),
    },
    async handler({ dcmjs, args }) {
      const asJson = args.format !== "lines";
      const result = await runCaptured(runDump, {
        dcmjs,
        positionals: [args.file],
        values: { json: asJson, raw: false },
      });
      if (result.code !== 0) {
        throw commandError("dicom_dump", result);
      }
      return asJson
        ? ok({ dataset: JSON.parse(result.stdoutLines.join("\n")) }, result)
        : ok({ lines: result.stdoutLines }, result);
    },
  },

  dicom_instance: {
    title: "DICOM file as DICOM JSON",
    description:
      "Read a local DICOM file and return standards-shaped DICOM JSON " +
      "(tag-keyed, vr/Value entries — the form DICOMweb metadata services " +
      "speak, and the form dicom_convert accepts as image metadata). " +
      "Binary values are base64 InlineBinary.",
    inputSchema: {
      file: z.string().describe("path to the DICOM file"),
    },
    async handler({ dcmjs, args }) {
      const result = await runCaptured(runInstance, {
        dcmjs,
        positionals: [args.file],
        values: {},
      });
      if (result.code !== 0) {
        throw commandError("dicom_instance", result);
      }
      return ok(
        { instance: JSON.parse(result.stdoutLines.join("\n")) },
        result
      );
    },
  },

  dicom_validate: {
    title: "Validate DICOM files",
    description:
      "Parse every DICOM file under a path (files are detected by magic " +
      "bytes, not extension) and report per-file status. Returns records " +
      "[{file, status: 'ok'|'fail', error?, bytes?, ms}] and a failure " +
      "count. Run this before pointing a pipeline at files of unknown " +
      "provenance, and after any tool that wrote DICOM output.",
    inputSchema: {
      path: z.string().describe("file or directory to validate"),
    },
    async handler({ dcmjs, args }) {
      const { records, failures } = await validateFiles({
        dcmjs,
        targets: [args.path],
      });
      return {
        ok: failures === 0,
        warnings: [],
        records,
        failures,
        total: records.length,
      };
    },
  },

  dicom_convert: {
    title: "Convert to/from DICOM",
    description:
      "Convert between representations. Input kind is auto-detected: DICOM " +
      "(→ json | dicomweb-json | fhir | dcm | pdf | mp4), PDF (→ dcm | " +
      "fhir), PNG/JPEG (→ dcm | dicomweb-json | json), MP4 (→ dcm). MP4 → " +
      "dcm encapsulates the H.264 stream VERBATIM as a Video Photographic " +
      "Image instance (Supplement 225 fragmented pixel data) — no " +
      "transcoding, streamed with bounded memory, so multi-GB files are " +
      "safe. Supported codecs: H.264 Baseline/Main/High up to Level 4.2; " +
      "anything else fails with the exact ffmpeg transcode command to run " +
      "first. DICOM video instance → mp4 recovers the byte-identical " +
      "original stream. For image input, metadata " +
      "is a DICOM JSON document — pass metadata explicitly or a " +
      "same-basename .json next to the image is discovered; any wrapper " +
      "document works (tag-keyed vr/Value entries are collected wherever " +
      "they sit; ignored keys are reported in warnings). Conformance is " +
      "enforced: actual image geometry beats metadata claims, and when the " +
      "metadata identifies the original instance the result gets a FRESH " +
      "SOPInstanceUID, ImageType DERIVED\\SECONDARY, and a " +
      "SourceImageSequence reference — original UIDs are never reused for " +
      "rebuilt pixels. If the metadata claims BitsStored>8 on an 8-bit " +
      "image, the tool proceeds at 8 bits and says so in warnings — pass " +
      "restore_values true to invert WindowCenter/WindowWidth instead " +
      "(output marked lossy). Binary targets (dcm, pdf, mp4) require " +
      "`output` and return { written }; JSON targets return { result }.",
    inputSchema: {
      input: z.string().describe("path to the input file"),
      to: z.enum(["dcm", "json", "dicomweb-json", "fhir", "pdf", "mp4"]),
      output: z
        .string()
        .optional()
        .describe("output path — required for dcm/pdf/mp4 targets"),
      metadata: z
        .string()
        .optional()
        .describe("image input: path to a DICOM JSON metadata document"),
      fhir_patient: z
        .string()
        .optional()
        .describe(
          "path to a FHIR Patient resource — its name/identifier/" +
            "birthDate/gender replace the whole patient module (fields " +
            "absent from the resource are written empty). Maps official " +
            "name over maiden, MR-typed identifier over others; gender " +
            "uses administrative gender only (male→M, female→F, " +
            "other/unrecognized→O, unknown→empty)."
        ),
      restore_values: z.boolean().optional(),
      patient_name: z.string().optional(),
      patient_id: z.string().optional(),
      title: z.string().optional(),
      study_uid: z.string().optional(),
      series_uid: z.string().optional(),
      fragment_bytes: z
        .number()
        .int()
        .optional()
        .describe(
          "mp4 → dcm: encapsulated fragment size in bytes (even, < 2^32; " +
            "default 268435456 = 256 MiB — output is streamed, so the " +
            "default is safe for multi-GB files)"
        ),
    },
    async handler({ dcmjs, args }) {
      const binaryTarget =
        args.to === "dcm" || args.to === "pdf" || args.to === "mp4";
      if (binaryTarget && !args.output) {
        throw new Error(
          `target "${args.to}" produces binary — pass output: <path> to ` +
            `receive { written: path } (bytes are never inlined)`
        );
      }
      const result = await runCaptured(runConvert, {
        dcmjs,
        positionals: [args.input],
        values: {
          to: args.to,
          output: args.output,
          metadata: args.metadata,
          "fhir-patient": args.fhir_patient,
          "restore-values": !!args.restore_values,
          "patient-name": args.patient_name,
          "patient-id": args.patient_id,
          title: args.title,
          "study-uid": args.study_uid,
          "series-uid": args.series_uid,
          "fragment-bytes":
            args.fragment_bytes !== undefined
              ? String(args.fragment_bytes)
              : undefined,
          pretty: false,
        },
      });
      if (result.code !== 0) {
        throw commandError("dicom_convert", result);
      }
      if (binaryTarget || (args.output && !binaryTarget)) {
        return ok({ written: args.output }, result);
      }
      return ok({ result: JSON.parse(result.stdoutLines.join("\n")) }, result);
    },
  },

  dicom_anonymize: {
    title: "Anonymize a DICOM file",
    description:
      "Strip PHI tags (dcmjs anonymizer default rule set) and write a " +
      "scrubbed copy — the input file is never modified, and writing over " +
      "the input is refused. Set dry_run true first to get the tag-level " +
      "change list ({ changes: [{tag, action, was, now?}] }) without " +
      "writing anything. Note: the default rules target standard PHI tags; " +
      "private tags and burned-in pixels are NOT covered — validate the " +
      "output and audit before release.",
    inputSchema: {
      file: z.string().describe("path to the DICOM file"),
      output: z
        .string()
        .optional()
        .describe("output path (default: <input>-anon.dcm)"),
      dry_run: z.boolean().optional(),
    },
    async handler({ dcmjs, args }) {
      const result = await runCaptured(runAnonymize, {
        dcmjs,
        positionals: [args.file],
        values: { output: args.output, "dry-run": !!args.dry_run },
      });
      if (result.code !== 0) {
        throw commandError("dicom_anonymize", result);
      }
      if (args.dry_run) {
        return ok(JSON.parse(result.stdoutLines.join("\n")), result);
      }
      const wroteLine = result.stdoutLines.find((l) => l.includes("wrote"));
      return ok(
        {
          written: wroteLine
            ? wroteLine.replace(/^anonymize: wrote /, "")
            : args.output,
        },
        result
      );
    },
  },

  dicom_filter: {
    title: "Rewrite tags in a streaming pass",
    description:
      "Stream a DICOM file through the event-stream filter chain into a " +
      "new file: set replaces tag values (e.g. patient name/MRN rewrites), " +
      "drop removes elements or whole sequences at any depth. Memory is " +
      "bounded by the largest fragment, so this works on inputs of any " +
      "size. Pixel data passes through untouched. A distinct output path " +
      "is required — in-place rewrites are refused. Changing identity tags " +
      "does NOT re-UID the instance: to fully re-identify, also set " +
      "00080018 (SOPInstanceUID), 0020000D, 0020000E with fresh 2.25.x " +
      "UIDs.",
    inputSchema: {
      input: z.string().describe("path to the input file"),
      output: z.string().describe("path for the filtered copy"),
      set: z
        .array(z.object({ tag: TAG, value: z.string() }))
        .optional()
        .describe("tag values to replace"),
      drop: z.array(TAG).optional().describe("tags to remove"),
      fhir_patient: z
        .string()
        .optional()
        .describe(
          "path to a FHIR Patient resource to apply to the patient module " +
            "— insert-or-replace, so de-identified files missing the tags " +
            "still receive the full module; fields absent from the " +
            "resource are written empty (deterministic overwrite)."
        ),
    },
    async handler({ dcmjs, args }) {
      const result = await runCaptured(runFilter, {
        dcmjs,
        positionals: [args.input],
        values: {
          output: args.output,
          set: (args.set || []).map((s) => `${s.tag}=${s.value}`),
          drop: args.drop || [],
          module: [],
          "fhir-patient": args.fhir_patient,
        },
      });
      if (result.code !== 0) {
        throw commandError("dicom_filter", result);
      }
      const wrote = result.stdoutLines.join("\n");
      const match = wrote.match(/wrote .* \(([\d,]+) bytes, (\d+) filters?\)/);
      return ok(
        {
          written: args.output,
          bytesWritten: match ? Number(match[1].replace(/,/g, "")) : undefined,
          filters: match ? Number(match[2]) : undefined,
        },
        result
      );
    },
  },

  dicomdir_create: {
    title: "Build a DICOMDIR",
    description:
      "Index every DICOM file under a directory into a DICOMDIR (Media " +
      "Storage Directory) with exact byte offsets. Referenced file names " +
      "must be ISO 9660 level 1 (A-Z 0-9 _, max 8 chars/component); " +
      "non-conformant names are indexed with a warning by default, or set " +
      "copy_to to stage a fully conformant CD-style tree " +
      "(DICOM/IM000001...) instead. Files missing required UIDs are " +
      "skipped and listed. Set dry_run true to get the full record tree, " +
      "warnings, and skip list without writing anything — review it " +
      "before committing to media.",
    inputSchema: {
      directory: z.string().describe("directory of DICOM files to index"),
      output: z
        .string()
        .optional()
        .describe("DICOMDIR path (default: <directory>/DICOMDIR)"),
      copy_to: z
        .string()
        .optional()
        .describe("stage a conformant CD-style tree at this destination"),
      fileset_id: z.string().optional(),
      strict: z.boolean().optional(),
      dry_run: z.boolean().optional(),
    },
    async handler({ dcmjs, args }) {
      const result = await runCaptured(runDicomdir, {
        dcmjs,
        positionals: [args.directory],
        values: {
          output: args.output,
          copy: args.copy_to,
          "fileset-id": args.fileset_id,
          strict: !!args.strict,
          json: !!args.dry_run,
        },
      });
      if (result.code !== 0) {
        throw commandError("dicomdir_create", result);
      }
      if (args.dry_run) {
        return ok(JSON.parse(result.stdoutLines.join("\n")), result);
      }
      const summary = result.stdoutLines.join("\n");
      const written =
        summary.match(/→ (.*) \([\d,]+ bytes\)/)?.[1] ??
        args.output ??
        `${args.directory}/DICOMDIR`;
      return ok(
        { written, summary: summary.replace(/^dicomdir: /, "") },
        result
      );
    },
  },

  dicomweb_create: {
    title: "Publish DICOM files as a Static-DICOMweb tree (optionally +FHIR)",
    description:
      "Build the Static-DICOMweb layout (studies/<uid>/series/... with " +
      "gzipped metadata and frame files — what OHIF and other DICOMweb " +
      "viewers read directly) from a directory of Part 10 DICOM files. " +
      "The source directory is auto-detected; every study found is " +
      "published unless study_instance_uid narrows it. A wrong UID is a " +
      "corrective error listing the studies actually present. With " +
      "fhir true, also writes <dest>/fhir: Patient + ImagingStudy + a " +
      "DICOMweb Endpoint resource, and a transaction Bundle.json a FHIR " +
      "server (HAPI, Medplum, ...) loads in one POST — the SMART-imaging " +
      "pattern (FHIR for discovery, DICOMweb for pixels). A provided " +
      "fhir_patient is embedded verbatim as the authoritative Patient; if " +
      "it disagrees with the instance tags a warning is returned (use " +
      "dicom_filter with fhir_patient first to align the instances). Set " +
      "wado_root to the URL the tree will be served from — the default " +
      "(http://localhost:5000/dicomweb) is only right for a local " +
      "static-wado-webserver.",
    inputSchema: {
      directory: z.string().describe("directory of Part 10 DICOM files"),
      destination: z
        .string()
        .optional()
        .describe("output root (default ./dicomweb)"),
      study_instance_uid: z.string().optional(),
      fhir: z
        .boolean()
        .optional()
        .describe("also write the FHIR layer (dicomweb+fhir format)"),
      fhir_patient: z
        .string()
        .optional()
        .describe("path to a FHIR Patient to embed verbatim"),
      fhir_encounter: z
        .string()
        .optional()
        .describe(
          "path to a FHIR Encounter to embed and reference from " +
            "ImagingStudy.encounter (not mapped onto DICOM tags)"
        ),
      wado_root: z
        .string()
        .optional()
        .describe("Endpoint.address — where the tree will be served"),
    },
    async handler({ dcmjs, args }) {
      const result = await runCaptured(runDicomweb, {
        dcmjs,
        positionals: [args.directory],
        values: {
          directory: args.destination,
          study: args.study_instance_uid,
          fhir: !!args.fhir,
          "fhir-patient": args.fhir_patient,
          "fhir-encounter": args.fhir_encounter,
          "wado-root": args.wado_root,
        },
      });
      if (result.code !== 0) {
        throw commandError("dicomweb_create", result);
      }
      const written = result.stdoutLines
        .map((line) => line.match(/→ (.*?)( \(|$)/)?.[1])
        .filter(Boolean);
      return ok({ written }, result);
    },
  },
};
