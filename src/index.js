import dcmjs from "./dcmjsBundle.js";
import { readFileArrayBuffer } from "./io.js";
import { dumpDict } from "./utils/dumpFormat.js";

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

/**
 * Print a parsed DicomDict as "(GGGG,EEEE) VR Keyword: value" tag lines,
 * meta group first — the same shared formatter `dcmjs dump` uses, so
 * library and CLI output cannot drift apart. Values with a BulkDataURI
 * or InlineBinary element shape print via their JSON form.
 */
export function dumpDicom(dicomDict, options = {}) {
  const stdout = options.stdout || console.log;
  const dictionary = DicomMetaDictionary.dictionary;
  if (dicomDict.meta) {
    dumpDict(dicomDict.meta, { dictionary, stdout });
  }
  dumpDict(dicomDict.dict, { dictionary, stdout });
}

export function instanceDicom(dicomDict, options = {}) {
  const stdout = options.stdout || console.log;
  const { pretty } = options;
  const result = pretty
    ? JSON.stringify(dicomDict.dict, null, 2)
    : JSON.stringify(dicomDict.dict);
  stdout("", result);
}
