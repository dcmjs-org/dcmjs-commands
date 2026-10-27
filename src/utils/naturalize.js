// src/utils/naturalize.js
//
// Naturalize DICOMWEB-JSON-SHAPED input: the pre-pass defaults a missing
// Value to [] (metadata responses legally omit it) before handing off to
// DicomMetaDictionary. For dicts parsed from Part 10 files that pre-pass
// is unnecessary — commands calling naturalizeDataset directly on a
// DicomMessage.readFile result are correct and deliberately do not route
// through here.

import dcmjs from "../dcmjsBundle.js";

export function naturalize(json) {
  if (!json) {
    throw new Error("json entry is null");
  }
  if (Array.isArray(json)) {
    return json.map(naturalize);
  }
  for (const [key, value] of Object.entries(json)) {
    if (value.vr && !value.Value && !value.BulkDataURI) {
      json[key].Value = [];
    }
  }
  return dcmjs.data.DicomMetaDictionary.naturalizeDataset(json);
}

export function denaturalize(natural) {
  if (Array.isArray(natural)) {
    return natural.map(denaturalize);
  }
  return dcmjs.data.DicomMetaDictionary.denaturalizeDataset(natural);
}
