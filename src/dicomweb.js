import zlib from 'zlib';
import fs from 'fs';

import { httprequest } from './webRetrieve.js';

export function readDicomWeb(url, options = {}) {
  if (url.startsWith('http')) {
    return readDicomWebHttp(url, options);
  }
  return readDicomWebFile(url, options);
}

export function readDicomWebHttp(url, options) {
  return httprequest(url, options);
}


export function readDicomWebFile(fileName, _options) {
  const isGzip = fileName.endsWith('.gz');
  const arrayBuffer = fs.readFileSync(fileName).buffer;
  const uncompressed = isGzip ? zlib.gunzipSync(arrayBuffer) : arrayBuffer;
  const str = uncompressed.toString();
  return JSON.parse(str);
}

export function queryDownloads(wadoUrl, options) {
  console.log("Querying for study", options.study);
  return [`${wadoUrl}?StudyInstanceUID=${options.study}`];
}

export function store(path, data, options) {
  console.log("Storign data", path, data);
}