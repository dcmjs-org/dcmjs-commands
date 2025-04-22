import dcmjs from "dcmjs";

export function naturalize(json) {
  if (Array.isArray(json)) {
    return json.map(naturalize);
  }
  return dcmjs.data.DicomMetaDictionary.naturalizeDataset(json);
}
