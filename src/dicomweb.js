import zlib from "zlib";
import fs from "fs";

import { httprequest } from "./webRetrieve.js";

/**
 * The dicomweb support functions for reading DICOMweb data from http
 * URLs or Static DICOMweb files.
 */

export function readDicomWeb(url, options = {}) {
  if (url.startsWith("http")) {
    return readDicomWebHttp(url, options);
  }
  return readDicomWebFile(url, options);
}

export function readDicomWebHttp(url, options) {
  return httprequest(url, options);
}

export function readDicomWebFile(fileName, _options) {
  const isGzip = fileName.endsWith(".gz");
  // Work on the Buffer directly — a bare `.buffer` is the shared read pool
  // for small files, and stringifying an ArrayBuffer yields
  // "[object ArrayBuffer]" rather than the content.
  const buf = fs.readFileSync(fileName);
  const uncompressed = isGzip ? zlib.gunzipSync(buf) : buf;
  return JSON.parse(uncompressed.toString("utf-8"));
}
