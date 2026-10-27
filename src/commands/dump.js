// src/commands/dump.js
//
// dcmjs dump <file.dcm> [--json]
// Default: "(GGGG,EEEE) VR Keyword: value" tag lines, meta group first.
// NOTE: this REPLACES the pre-1.0 dump output ("key name value" lines
// under Metadata/Data headers) — a breaking output-format change, listed
// as such in the release notes; it is not compatible with the old form.
// --json:  naturalized dataset as pretty JSON with binary summarized.
// --raw:   accepted alias of the default (kept for compatibility with the
//          ported CLI's flag).

import { readFileArrayBuffer, binaryReplacer } from "../io.js";
import { dumpDict } from "../utils/dumpFormat.js";

export const dumpUsage = `usage: dcmjs dump <file.dcm> [--json]

Print a DICOM file's dataset to stdout.

    --json   naturalized JSON instead of tag/VR lines
    --raw    tag/VR lines (the default; kept for compatibility)
`;

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
      // Default (and --raw alias): tag lines via the shared formatter
      const dictionary = DicomMetaDictionary.dictionary;
      dumpDict(dicomDict.meta, { dictionary, stdout });
      dumpDict(dicomDict.dict, { dictionary, stdout });
    }
    return 0;
  } catch (err) {
    stderr(`dump: ${err.message}`);
    return 1;
  }
}
