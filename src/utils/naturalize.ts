import dcmjs from "dcmjs";

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
