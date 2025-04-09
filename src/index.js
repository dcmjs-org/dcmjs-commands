import fs from "fs";
import dcmjs from "dcmjs";

export * as utils from "./utils/index.js";
export * as dicomweb from "./dicomweb.js";
export * from "./access/DicomAccess";

const { DicomMessage, DicomMetaDictionary } = dcmjs.data;

export function readDicom(fileName) {
  const arrayBuffer = fs.readFileSync(fileName).buffer;
  const dicomDict = DicomMessage.readFile(arrayBuffer);
  return dicomDict;
}

export function dumpDicom(dicomDict, options = {}) {
  if (dicomDict.meta) {
    console.log("Metadata");
    dumpData(dicomDict.meta, options);
  }
  console.log("Data");
  dumpData(dicomDict.dict, options);
}

export function dumpData(data, options, indent = "") {
  if (typeof data !== "object") {
    return;
  }
  const keys = Object.keys(data).sort();
  for (const key of keys) {
    const value = data[key];
    if (!value) {
      continue;
    }
    const { vr } = value;
    const punctuatedTag = DicomMetaDictionary.punctuateTag(key);
    const entry = DicomMetaDictionary.dictionary[punctuatedTag];
    const name = entry?.name || "";
    if (vr === "SQ") {
      console.log(indent, key, name);
      dumpSq(name || key, value, options, indent + "  ");
      continue;
    }
    console.log(indent, key, name, valueToString(value, options));
  }
}

export function valueToString(value, options) {
  const { Value: values, vr, InlineBinary, BulkDataURI } = value;
  if (InlineBinary) {
    return `Inline Binary ${InlineBinary.substring(0, Math.min(InlineBinary.length, 32))}${InlineBinary.length > 31 ? "..." : ""} (${(InlineBinary.length * 3) / 4})`;
  }
  if (BulkDataURI) {
    return `URL ${BulkDataURI}`;
  }
  if (!values) {
    if (vr) {
      return vr;
    }
    console.log("***** Value = ", value);
    return "";
  }
  if (values.length === 0) return "";
  const [v0] = values;
  if (v0 instanceof ArrayBuffer) {
    return `ArrayBuffer of length ${values.length}`;
  }
  if (typeof v0 === "object") {
    return values.map((it) => JSON.stringify(it)).join(", ");
  }
  if (!Array.isArray(values)) {
    return JSON.stringify(values);
  }
  return values.map((it) => String(it)).join(", ");
}

export function dumpSq(tag, value, options, indent) {
  const { Value: sq } = value;
  if (sq?.length === undefined) {
    console.log("Empty SQ");
    return;
  }
  for (let i = 0; i < sq.length; i++) {
    console.log(indent, "Item #", i + 1);
    dumpData(sq[i], options, indent + "  ");
  }
  console.log(indent, "End of", tag, "with", sq.length, "items");
}

export function instanceDicom(dicomDict, options = {}) {
  const { pretty } = options;
  const result = pretty
    ? JSON.stringify(dicomDict.dict, null, 2)
    : JSON.stringify(dicomDict.dict);
  console.log("", result);
}
