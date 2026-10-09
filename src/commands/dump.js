// src/commands/dump.js
//
// dcmjs dump <file.dcm> [--json]
// Default: "(GGGG,EEEE) VR Keyword: value" tag lines, meta group first —
// the legacy dcmjs-commands dump behavior, via the improved dumper.
// --json:  naturalized dataset as pretty JSON with binary summarized.
// --raw:   accepted alias of the default (kept for compatibility with the
//          ported CLI's flag).

import { readFileArrayBuffer, binaryReplacer } from "../io.js";

export const dumpUsage = `usage: dcmjs dump <file.dcm> [--json]

Print a DICOM file's dataset to stdout.

    --json   naturalized JSON instead of tag/VR lines
    --raw    tag/VR lines (the default; kept for compatibility)
`;

function formatValue(element) {
  const value = element.Value;
  if (value === undefined || value === null) {
    return "";
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => {
      if (item instanceof ArrayBuffer || ArrayBuffer.isView(item)) {
        return `[${element.vr} ${item.byteLength} bytes]`;
      }
      if (item && typeof item === "object" && "Alphabetic" in item) {
        return item.Alphabetic;
      }
      if (item && typeof item === "object") {
        return "<item>";
      }
      return String(item);
    });
    return parts.join("\\");
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return `[${element.vr} ${value.byteLength} bytes]`;
  }
  return String(value);
}

function dumpGroup(group, { dictionary, stdout, indent = "" }) {
  for (const tag of Object.keys(group).sort()) {
    const element = group[tag];
    const punctuated = `(${tag.substring(0, 4)},${tag.substring(4, 8)})`;
    const entry = dictionary[punctuated];
    const keyword = entry ? entry.name : "Unknown";
    if (element.vr === "SQ" && Array.isArray(element.Value)) {
      stdout(
        `${indent}${punctuated} SQ ${keyword}: ${element.Value.length} item(s)`
      );
      element.Value.forEach((item) => {
        dumpGroup(item, {
          dictionary,
          stdout,
          indent: indent + "    ",
        });
      });
    } else {
      stdout(
        `${indent}${punctuated} ${element.vr} ${keyword}: ${formatValue(
          element
        )}`
      );
    }
  }
}

export async function runDump({ dcmjs, positionals, values, stdout, stderr }) {
  const [input] = positionals;
  if (!input) {
    stderr(dumpUsage);
    return 1;
  }

  try {
    const { DicomMessage, DicomMetaDictionary } = dcmjs.data;
    const dicomDict = DicomMessage.readFile(readFileArrayBuffer(input));

    if (values.json) {
      const dataset = DicomMetaDictionary.naturalizeDataset(dicomDict.dict);
      stdout(JSON.stringify(dataset, binaryReplacer("summary"), 4));
    } else {
      // Default (and --raw alias): legacy-style tag lines
      const dictionary = DicomMetaDictionary.dictionary;
      dumpGroup(dicomDict.meta, { dictionary, stdout });
      dumpGroup(dicomDict.dict, { dictionary, stdout });
    }
    return 0;
  } catch (err) {
    stderr(`dump: ${err.message}`);
    return 1;
  }
}
