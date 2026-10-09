// src/commands/instance.js
//
// dcmjs instance <file.dcm> [--pretty]
// Legacy command: print the parsed dict as tag-keyed DICOM JSON. Binary
// values are base64-encoded (the legacy version silently emitted {} for
// ArrayBuffers).

import { readFileArrayBuffer, binaryReplacer } from "../io.js";

export const instanceUsage = `usage: dcmjs instance <file.dcm> [--pretty]

Print a DICOM file's dict as tag-keyed DICOM JSON.

    -p, --pretty   pretty-print the JSON
`;

export async function runInstance({
  dcmjs,
  positionals,
  values,
  stdout,
  stderr,
}) {
  const [input] = positionals;
  if (!input) {
    stderr(instanceUsage);
    return 1;
  }

  try {
    const { DicomMessage } = dcmjs.data;
    const dicomDict = DicomMessage.readFile(readFileArrayBuffer(input));
    stdout(
      JSON.stringify(
        dicomDict.dict,
        binaryReplacer("base64"),
        values.pretty ? 2 : 0
      )
    );
    return 0;
  } catch (err) {
    stderr(`instance: ${err.message}`);
    return 1;
  }
}
