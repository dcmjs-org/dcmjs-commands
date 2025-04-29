import dcmjs from "dcmjs";

export function naturalize(json) {
  if (Array.isArray(json)) {
    return json.map(naturalize);
  }
  return dcmjs.data.DicomMetaDictionary.naturalizeDataset(json);
}

export function denaturalize(natural) {
  if (Array.isArray(natural)) {
    return natural.map(denaturalize);
  }
  return dcmjs.data.DicomMetaDictionary.denaturalizeDataset(natural);
}
