// src/commands/dicomdir.js
//
// dcmjs dicomdir <directory> [options]
//
// Build a DICOMDIR (Media Storage Directory) for a tree of Part 10 files.
// Record keys are extracted with a partial parse that stops before
// PixelData, so a 500-slice study indexes in moments; the offset math
// lives in dcmjs.media.writeDicomDir (measure-then-write, real byte
// offsets). --copy stages a conformant CD-style tree (DICOM/IM000001...)
// when the source file names aren't ISO 9660 level 1.

import fs from "node:fs";
import path from "node:path";
import { discoverDicomFiles, readFileArrayBuffer } from "../io.js";

export const dicomdirUsage = `usage: dcmjs dicomdir <directory> [options]

Build a DICOMDIR indexing every DICOM file under <directory>.

Options:
    -o, --output <file>    DICOMDIR path (default: <directory>/DICOMDIR)
    --copy <dest>          stage a conformant CD-style tree instead:
                           <dest>/DICOM/IM000001... plus <dest>/DICOMDIR
    --fileset-id <id>      FileSetID (default DCMJS)
    --strict               error (instead of warn) on referenced file names
                           that are not ISO 9660 level 1 conformant
    --json                 dry run: print the record tree, warnings, and
                           skipped files as JSON; write nothing
`;

const FILE_ID_COMPONENT = /^[A-Z0-9_]{1,8}$/;

/** Partial-parse one Part 10 file into a DICOMDIR entry description. */
function extractEntry({ dcmjs, filePath, rootDir }) {
  const { DicomMessage, DicomMetaDictionary } = dcmjs.data;
  const dicomDict = DicomMessage.readFile(readFileArrayBuffer(filePath), {
    untilTag: "7FE00010",
    stopOnGreaterTag: true,
  });
  const dataset = DicomMetaDictionary.naturalizeDataset(dicomDict.dict);
  const meta = DicomMetaDictionary.naturalizeDataset(dicomDict.meta);

  const missing = [
    ["SOPInstanceUID", dataset.SOPInstanceUID],
    ["SOPClassUID", dataset.SOPClassUID],
    ["StudyInstanceUID", dataset.StudyInstanceUID],
    ["SeriesInstanceUID", dataset.SeriesInstanceUID],
  ]
    .filter(([, value]) => !value)
    .map(([keyword]) => keyword);
  if (missing.length) {
    return { skipped: { file: filePath, missing } };
  }

  const relative = path.relative(rootDir, filePath);
  return {
    entry: {
      referencedFileID: relative.split(path.sep),
      sopClassUid: dataset.SOPClassUID,
      sopInstanceUid: dataset.SOPInstanceUID,
      transferSyntaxUid: meta.TransferSyntaxUID || "1.2.840.10008.1.2.1",
      patient: {
        // DICOMDIR requires a PatientID key; fall back so ID-less files
        // still index instead of being dropped.
        PatientID: dataset.PatientID || "UNKNOWN",
        PatientName: dataset.PatientName ? String(dataset.PatientName) : "",
      },
      study: {
        StudyInstanceUID: dataset.StudyInstanceUID,
        StudyDate: dataset.StudyDate || "",
        StudyTime: dataset.StudyTime || "",
        StudyDescription: dataset.StudyDescription || "",
        AccessionNumber: dataset.AccessionNumber || "",
        StudyID: dataset.StudyID || "",
      },
      series: {
        SeriesInstanceUID: dataset.SeriesInstanceUID,
        Modality: dataset.Modality || "OT",
        SeriesNumber: dataset.SeriesNumber ?? 1,
      },
      instance: {
        InstanceNumber: dataset.InstanceNumber ?? 1,
      },
      sourcePath: filePath,
    },
  };
}

function nonConformingComponents(entry) {
  return entry.referencedFileID.filter(
    (component) => !FILE_ID_COMPONENT.test(component)
  );
}

/** Sort for stable IM%06d numbering: patient, study, series, instance. */
function stagingOrder(a, b) {
  return (
    a.patient.PatientID.localeCompare(b.patient.PatientID) ||
    a.study.StudyInstanceUID.localeCompare(b.study.StudyInstanceUID) ||
    a.series.SeriesInstanceUID.localeCompare(b.series.SeriesInstanceUID) ||
    a.instance.InstanceNumber - b.instance.InstanceNumber ||
    a.sopInstanceUid.localeCompare(b.sopInstanceUid)
  );
}

export async function runDicomdir({
  dcmjs,
  positionals,
  values,
  stdout,
  stderr,
}) {
  const [rootDir] = positionals;
  if (!rootDir) {
    stderr("dicomdir: missing <directory>");
    stderr(dicomdirUsage);
    return 1;
  }

  try {
    const files = discoverDicomFiles(rootDir);
    if (!files.length) {
      throw new Error(`no DICOM files found under ${rootDir}`);
    }

    const entries = [];
    const skipped = [];
    for (const filePath of files) {
      const result = extractEntry({ dcmjs, filePath, rootDir });
      if (result.skipped) {
        skipped.push(result.skipped);
        stderr(
          `dicomdir: warning: skipping ${result.skipped.file} — missing ` +
            result.skipped.missing.join(", ")
        );
      } else {
        entries.push(result.entry);
      }
    }
    if (!entries.length) {
      throw new Error(
        `all ${files.length} files were skipped — nothing to index`
      );
    }

    const warnings = [];
    let output = values.output || path.join(rootDir, "DICOMDIR");
    let allowNonConforming = false;

    if (values.copy) {
      // Stage a conformant tree: every name becomes DICOM/IM%06d.
      const dest = values.copy;
      const dicomDir = path.join(dest, "DICOM");
      if (fs.existsSync(dicomDir) && fs.readdirSync(dicomDir).length) {
        throw new Error(
          `${dicomDir} exists and is not empty — refusing to merge into it; ` +
            `pick a fresh --copy destination`
        );
      }
      entries.sort(stagingOrder);
      if (!values.json) {
        fs.mkdirSync(dicomDir, { recursive: true });
      }
      entries.forEach((entry, index) => {
        const name = `IM${String(index + 1).padStart(6, "0")}`;
        if (!values.json) {
          fs.copyFileSync(entry.sourcePath, path.join(dicomDir, name));
        }
        entry.referencedFileID = ["DICOM", name];
      });
      output = path.join(dest, "DICOMDIR");
    } else {
      // Index in place: keep relative paths, flag non-conformant names.
      for (const entry of entries) {
        const bad = nonConformingComponents(entry);
        if (bad.length) {
          const message =
            `"${entry.referencedFileID.join("/")}" is not ISO 9660 level 1 ` +
            `conformant (${bad.join(", ")}); some readers will reject it — ` +
            `use --copy <dest> for a conformant tree`;
          if (values.strict) {
            throw new Error(`dicomdir: ${message}`);
          }
          warnings.push(message);
          allowNonConforming = true;
        }
      }
      for (const message of warnings.slice(0, 5)) {
        stderr(`dicomdir: warning: ${message}`);
      }
      if (warnings.length > 5) {
        stderr(`dicomdir: warning: ...and ${warnings.length - 5} more`);
      }
    }

    const summary = {
      instances: entries.length,
      series: new Set(entries.map((e) => e.series.SeriesInstanceUID)).size,
      studies: new Set(entries.map((e) => e.study.StudyInstanceUID)).size,
      patients: new Set(entries.map((e) => e.patient.PatientID)).size,
    };

    if (values.json) {
      // Dry run: the exact payload the MCP dicomdir_create dry_run returns.
      stdout(
        JSON.stringify(
          {
            output,
            summary,
            entries: entries.map(
              ({ sourcePath: _sourcePath, ...entry }) => entry
            ),
            warnings,
            skipped,
          },
          null,
          2
        )
      );
      return 0;
    }

    const bytes = dcmjs.media.writeDicomDir(entries, {
      fileSetID: values["fileset-id"] || "DCMJS",
      allowNonConformingFileIDs: allowNonConforming,
    });
    fs.writeFileSync(output, Buffer.from(bytes));

    stdout(
      `dicomdir: ${summary.instances} instances, ${summary.series} series, ` +
        `${summary.studies} ${summary.studies === 1 ? "study" : "studies"}, ` +
        `${summary.patients} ${summary.patients === 1 ? "patient" : "patients"} ` +
        `→ ${output} (${bytes.byteLength.toLocaleString()} bytes)`
    );
    return 0;
  } catch (err) {
    stderr(`dicomdir: ${err.message}`);
    return 1;
  }
}
