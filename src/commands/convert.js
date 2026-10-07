// src/commands/convert.js
//
// dcmjs convert <input> --to <format> [options]
//
// The PACS PDF workflow both ways plus JSON/FHIR conversions, and the
// forward-migration path for images exported from antiquated DICOM files:
//   .dcm → json | dicomweb-json | fhir | dcm | pdf (extract encapsulated)
//   .pdf → dcm (Encapsulated PDF wrap) | fhir (DocumentReference)
//   .png/.jpg → dcm | dicomweb-json | json  (with optional DICOM JSON
//        metadata sidecar; conformance handled by dcmjs fromImage — fresh
//        SOPInstanceUID, DERIVED\SECONDARY when a source instance is known)

import fs from "node:fs";
import path from "node:path";
import {
  readFileArrayBuffer,
  sniffKind,
  binaryReplacer,
  writeOutput,
} from "../io.js";
import { decodeImage } from "../imaging/decodeImage.js";
import { extractTagKeyedJson } from "../utils/extractTagKeyedJson.js";
import { loadFhirPatientAttrs } from "./filter.js";
import { PATIENT_MODULE } from "../filters/fhirPatient.js";
import {
  convertMp4ToDicom,
  convertDicomToMp4,
  parseFragmentBytes,
} from "./convertVideo.js";

export const convertUsage = `usage: dcmjs convert <input> --to <format> [options]

Formats (auto-detected input kind → supported targets):
    .dcm → fhir | dicomweb-json | json | dcm | pdf | mp4 (video instances)
    .pdf → dcm | fhir
    .png/.jpg → dcm | dicomweb-json | json
    .mp4 → dcm (Supplement 225 video encapsulation, streamed — any size)

Options:
    -t, --to <format>        target format (required)
    -o, --output <file>      output path (required for binary targets)
    --pretty                 pretty-print JSON output
    --bundle                 fhir: emit a collection Bundle
    --fhir-version <v>       R4 | R4B (default R4B)
    --patient-name <name>    pdf/image input: PatientName
    --patient-id <id>        pdf/image input: PatientID
    --title <title>          pdf input: DocumentTitle
    --study-uid <uid>        pdf/image input: attach to an existing StudyInstanceUID
    --series-uid <uid>       pdf/image input: SeriesInstanceUID
    --fhir-patient <file>    apply a FHIR Patient resource's demographics
                             (any input kind; overrides metadata and
                             --patient-name/--patient-id)
    -m, --metadata <file>    image input: DICOM JSON metadata document
                             (default: same-basename .json next to the image)
    --restore-values         image input: rebuild approximate stored values by
                             inverting WindowCenter/WindowWidth (8-bit input
                             with window metadata only)
    --fragment-bytes <n>     mp4 input: encapsulated fragment size in bytes
                             (even, < 2^32; default 268435456 = 256 MiB)
`;

function stringify(value, pretty) {
  return JSON.stringify(value, binaryReplacer("base64"), pretty ? 4 : 0);
}

function pdfOptionsFromValues(values) {
  const options = {};
  if (values["patient-name"]) {
    options.PatientName = values["patient-name"];
  }
  if (values["patient-id"]) {
    options.PatientID = values["patient-id"];
  }
  if (values.title) {
    options.DocumentTitle = values.title;
  }
  if (values["study-uid"]) {
    options.StudyInstanceUID = values["study-uid"];
  }
  if (values["series-uid"]) {
    options.SeriesInstanceUID = values["series-uid"];
  }
  return options;
}

/** Insert-or-replace the patient module on a parsed DicomDict. */
function applyFhirAttrsToDict(dicomDict, fhirAttrs) {
  for (const { tag, vr, keyword } of PATIENT_MODULE) {
    const value = fhirAttrs[keyword];
    dicomDict.upsertTag(tag, vr, value ? [value] : []);
  }
}

async function convertDicom({ dcmjs, arrayBuffer, to, values, fhirAttrs }) {
  const { DicomMessage, DicomMetaDictionary } = dcmjs.data;
  const fhirVersion = values["fhir-version"] || "R4B";

  if (fhirAttrs) {
    // Rewrite once up front so every target sees the applied demographics.
    const dicomDict = DicomMessage.readFile(arrayBuffer);
    applyFhirAttrsToDict(dicomDict, fhirAttrs);
    arrayBuffer = dicomDict.write();
  }

  if (to === "json") {
    const dataset = DicomMetaDictionary.naturalizeDataset(
      DicomMessage.readFile(arrayBuffer).dict
    );
    return { text: stringify(dataset, values.pretty) };
  }

  if (to === "dicomweb-json") {
    const json =
      await dcmjs.eventStream.DicomEventStream.fromPart10(
        arrayBuffer
      ).toDicomWebJson();
    return { text: stringify(json, values.pretty) };
  }

  if (to === "fhir") {
    if (values.bundle) {
      const dataset = DicomMetaDictionary.naturalizeDataset(
        DicomMessage.readFile(arrayBuffer).dict
      );
      const bundle = dcmjs.fhir.toBundle([dataset], { fhirVersion });
      return { text: stringify(bundle, values.pretty) };
    }
    const resources = dcmjs.fhir.fromPart10(arrayBuffer, { fhirVersion });
    return { text: stringify(resources, values.pretty) };
  }

  if (to === "dcm") {
    const dicomDict = DicomMessage.readFile(arrayBuffer);
    return { binary: Buffer.from(dicomDict.write()) };
  }

  if (to === "pdf") {
    const dataset = DicomMetaDictionary.naturalizeDataset(
      DicomMessage.readFile(arrayBuffer).dict
    );
    const { bytes } = dcmjs.encapsulated.extractEncapsulatedPdf(dataset);
    return { binary: Buffer.from(bytes) };
  }

  throw new Error(`unsupported conversion: dicom → ${to}`);
}

/**
 * Locate and parse the metadata document for an image input. Explicit
 * --metadata must exist and parse; the auto-discovered same-basename .json
 * is optional (a bare image converts with minimal defaults).
 */
function resolveImageMetadata(input, values, stderr) {
  const explicit = values.metadata;
  const candidate =
    explicit ||
    path.format({
      ...path.parse(input),
      base: undefined,
      ext: ".json",
    });

  if (!fs.existsSync(candidate)) {
    if (explicit) {
      throw new Error(`metadata file not found: ${explicit}`);
    }
    return { tags: {}, meta: {}, ignoredKeys: [], source: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
  } catch (err) {
    throw new Error(
      `could not parse metadata ${candidate}: ${err.message} — fix the JSON ` +
        `or pass a different --metadata file`
    );
  }

  const extracted = extractTagKeyedJson(parsed);
  if (!Object.keys(extracted.tags).length) {
    stderr(
      `convert: warning: ${candidate} contains no DICOM JSON entries — ` +
        `converting with minimal defaults`
    );
  }
  return { ...extracted, source: candidate };
}

/** First numeric value of a tag entry, else undefined. */
function tagNumber(tags, tag) {
  const value = tags[tag]?.Value?.[0];
  return value === undefined || value === null ? undefined : Number(value);
}

/**
 * Invert the linear VOI transform (PS3.3 C.11.2.1.2) to rebuild approximate
 * stored values from window-rendered 8-bit pixels:
 *   stored = ((p / 255) - 0.5) * (WW - 1) + (WC - 0.5)
 */
function restoreStoredValues(decoded, tags, stderr) {
  const windowCenter = tagNumber(tags, "00281050");
  const windowWidth = tagNumber(tags, "00281051");
  if (windowCenter === undefined || windowWidth === undefined) {
    throw new Error(
      "--restore-values needs WindowCenter (0028,1050) and WindowWidth " +
        "(0028,1051) in the metadata — add them or drop --restore-values"
    );
  }
  if (decoded.bitsAllocated !== 8 || decoded.samplesPerPixel !== 1) {
    throw new Error(
      "--restore-values applies to 8-bit grayscale input only — this image " +
        `is ${decoded.bitsAllocated}-bit ${decoded.photometricInterpretation}`
    );
  }

  const signed = tagNumber(tags, "00280103") === 1;
  const bitsStored = tagNumber(tags, "00280101") || 16;
  const low = signed ? -(2 ** (bitsStored - 1)) : 0;
  const high = signed ? 2 ** (bitsStored - 1) - 1 : 2 ** bitsStored - 1;

  const source = decoded.pixels;
  const restored = signed
    ? new Int16Array(source.length)
    : new Uint16Array(source.length);
  for (let i = 0; i < source.length; i++) {
    const stored = Math.round(
      (source[i] / 255 - 0.5) * (windowWidth - 1) + (windowCenter - 0.5)
    );
    restored[i] = Math.min(high, Math.max(low, stored));
  }

  stderr(
    `convert: restored ~${bitsStored}-bit stored values from ` +
      `WindowCenter ${windowCenter} / WindowWidth ${windowWidth} (lossy 8-bit source)`
  );

  return {
    ...decoded,
    pixels: restored,
    bitsAllocated: 16,
    bitsStored,
    highBit: bitsStored - 1,
    pixelRepresentation: signed ? 1 : 0,
  };
}

async function convertImage({
  dcmjs,
  arrayBuffer,
  kind,
  to,
  values,
  input,
  stderr,
  fhirAttrs,
}) {
  const metadata = resolveImageMetadata(input, values, stderr);
  let decoded = decodeImage(kind, arrayBuffer);

  // Actual pixels vs metadata claims: dimensions are a hard error the caller
  // can fix; bit depth silently proceeds at the real depth with a warning.
  const claimedRows = tagNumber(metadata.tags, "00280010");
  const claimedColumns = tagNumber(metadata.tags, "00280011");
  if (
    (claimedRows !== undefined && claimedRows !== decoded.rows) ||
    (claimedColumns !== undefined && claimedColumns !== decoded.columns)
  ) {
    throw new Error(
      `decoded ${kind.toUpperCase()} is ${decoded.columns}x${decoded.rows} ` +
        `but metadata claims Columns=${claimedColumns} Rows=${claimedRows} — ` +
        `fix the sidecar or drop its Rows/Columns to accept the image dimensions`
    );
  }

  if (values["restore-values"]) {
    decoded = restoreStoredValues(decoded, metadata.tags, stderr);
  } else {
    const claimedBitsStored = tagNumber(metadata.tags, "00280101");
    if (
      claimedBitsStored !== undefined &&
      claimedBitsStored > decoded.bitsStored
    ) {
      stderr(
        `convert: warning: image is ${decoded.bitsStored}-bit but metadata ` +
          `claims BitsStored=${claimedBitsStored} — pass --restore-values to ` +
          `rebuild stored values, or accept ${decoded.bitsStored}-bit output`
      );
    }
  }

  if (metadata.ignoredKeys.length) {
    stderr(
      `convert: note: ignored non-DICOM sidecar keys: ` +
        metadata.ignoredKeys.slice(0, 8).join(", ") +
        (metadata.ignoredKeys.length > 8 ? ", ..." : "")
    );
  }

  const events = dcmjs.eventStream.DicomEventStream.fromImage(decoded, {
    metadata: Object.keys(metadata.tags).length ? metadata.tags : undefined,
    ...pdfOptionsFromValues(values),
    // FHIR Patient wins over metadata and the individual patient flags;
    // its empties are deliberate (deterministic overwrite of the module)
    ...(fhirAttrs || {}),
    ...(values["restore-values"] ? { lossy: { method: "ISO_10918_1" } } : {}),
  });

  if (to === "dcm") {
    return { binary: Buffer.from(await events.toPart10()) };
  }
  if (to === "dicomweb-json") {
    return { text: stringify(await events.toDicomWebJson(), values.pretty) };
  }
  if (to === "json") {
    return { text: stringify(await events.toNaturalized(), values.pretty) };
  }

  throw new Error(`unsupported conversion: ${kind} → ${to}`);
}

async function convertPdf({ dcmjs, arrayBuffer, to, values, fhirAttrs }) {
  const fhirVersion = values["fhir-version"] || "R4B";
  const dataset = dcmjs.encapsulated.encapsulatePdf(arrayBuffer, {
    ...pdfOptionsFromValues(values),
    ...(fhirAttrs || {}),
  });

  if (to === "dcm") {
    return { binary: dcmjs.data.datasetToBuffer(dataset) };
  }

  if (to === "fhir") {
    if (values.bundle) {
      const bundle = dcmjs.fhir.toBundle([dataset], { fhirVersion });
      return { text: stringify(bundle, values.pretty) };
    }
    const resources = dcmjs.fhir.toFhir(dataset, { fhirVersion });
    return { text: stringify(resources, values.pretty) };
  }

  throw new Error(`unsupported conversion: pdf → ${to}`);
}

export async function runConvert({
  dcmjs,
  positionals,
  values,
  stdout,
  stderr,
}) {
  const [input] = positionals;
  const to = values.to;

  if (!input || !to) {
    stderr(
      !input ? "convert: missing input file" : "convert: missing --to <format>"
    );
    stderr(convertUsage);
    return 1;
  }

  try {
    const kind = sniffKind(input);
    if (kind === "unknown") {
      throw new Error(
        `cannot determine input kind of ${input} (not DICOM, not PDF, not PNG, not JPEG, not MP4)`
      );
    }

    const fhirAttrs = values["fhir-patient"]
      ? loadFhirPatientAttrs(dcmjs, values["fhir-patient"])
      : null;

    // Video paths stream and never buffer the input — route them before
    // readFileArrayBuffer (a 21.8 GB MP4 is a legal input here).
    if (kind === "mp4") {
      if (to !== "dcm") {
        throw new Error(
          `unsupported conversion: mp4 → ${to} — an MP4 input converts to ` +
            "dcm only (Supplement 225 video encapsulation)"
        );
      }
      if (!values.output) {
        throw new Error("mp4 → dcm produces binary; use -o <file>");
      }
      const code = await convertMp4ToDicom({
        dcmjs,
        input,
        output: values.output,
        options: { ...pdfOptionsFromValues(values), ...(fhirAttrs || {}) },
        fragmentBytes: parseFragmentBytes(values),
        stderr,
      });
      return code;
    }
    if (kind === "dicom" && to === "mp4") {
      if (!values.output) {
        throw new Error("dcm → mp4 produces binary; use -o <file>");
      }
      if (fhirAttrs) {
        // The extracted MP4 carries no DICOM attributes — silently
        // accepting the flag would let a caller believe the demographics
        // were applied somewhere.
        throw new Error(
          "--fhir-patient does not apply to dcm → mp4 (the extracted MP4 " +
            "carries no DICOM attributes); apply it to the input with " +
            "dcmjs filter --fhir-patient instead"
        );
      }
      return await convertDicomToMp4({
        dcmjs,
        input,
        output: values.output,
        stderr,
      });
    }

    const arrayBuffer = readFileArrayBuffer(input);
    const result =
      kind === "dicom"
        ? await convertDicom({ dcmjs, arrayBuffer, to, values, fhirAttrs })
        : kind === "pdf"
          ? await convertPdf({ dcmjs, arrayBuffer, to, values, fhirAttrs })
          : await convertImage({
              dcmjs,
              arrayBuffer,
              kind,
              to,
              values,
              input,
              stderr,
              fhirAttrs,
            });

    const written = writeOutput({
      output: values.output,
      data: result.binary !== undefined ? result.binary : result.text,
      stdout,
    });
    if (written && result.binary !== undefined) {
      stderr(`convert: wrote ${written}`);
    }
    return 0;
  } catch (err) {
    stderr(`convert: ${err.message}`);
    return 1;
  }
}
