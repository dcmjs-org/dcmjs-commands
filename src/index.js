import dcmjs from "./dcmjsBundle.js";
import { readFileArrayBuffer } from "./io.js";

export * as utils from "./utils/index.js";
export * as dicomweb from "./dicomweb.js";
export * from "./access/DicomAccess.js";

const { DicomMessage, DicomMetaDictionary } = dcmjs.data;

export function readDicom(fileName) {
  // Exact ArrayBuffer slice — a bare fs.readFileSync(...).buffer returns the
  // shared read pool for small files, handing the parser unrelated bytes.
  const arrayBuffer = readFileArrayBuffer(fileName);
  const dicomDict = DicomMessage.readFile(arrayBuffer);
  return dicomDict;
}

export function dumpDicom(dicomDict, options = {}) {
  const stdout = options.stdout || console.log;
  if (dicomDict.meta) {
    stdout("Metadata");
    dumpData(dicomDict.meta, options);
  }
  stdout("Data");
  dumpData(dicomDict.dict, options);
}

export function dumpData(data, options = {}, indent = "") {
  const stdout = options.stdout || console.log;
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
      stdout(indent, key, name);
      dumpSq(name || key, value, options, indent + "  ");
      continue;
    }
    stdout(indent, key, name, valueToString(value, options));
  }
}

export function valueToString(value, _options) {
  const { Value: values, vr, InlineBinary, BulkDataURI } = value;
  if (InlineBinary) {
    return `Inline Binary ${InlineBinary.substring(0, Math.min(InlineBinary.length, 32))}${InlineBinary.length > 31 ? "..." : ""} (${(InlineBinary.length * 3) / 4})`;
  }
  if (BulkDataURI) {
    return `URL ${BulkDataURI}`;
  }
  if (!values) {
    return vr || "";
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

export function dumpSq(tag, value, options = {}, indent) {
  const stdout = options.stdout || console.log;
  const { Value: sq } = value;
  if (sq?.length === undefined) {
    stdout("Empty SQ");
    return;
  }
  for (let i = 0; i < sq.length; i++) {
    stdout(indent, "Item #", i + 1);
    dumpData(sq[i], options, indent + "  ");
  }
  stdout(indent, "End of", tag, "with", sq.length, "items");
}

export function instanceDicom(dicomDict, options = {}) {
  const stdout = options.stdout || console.log;
  const { pretty } = options;
  const result = pretty
    ? JSON.stringify(dicomDict.dict, null, 2)
    : JSON.stringify(dicomDict.dict);
  stdout("", result);
}
