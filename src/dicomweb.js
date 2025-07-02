import zlib from "zlib";
import fs from "fs";
import dcmjs from "dcmjs";

import { httprequest } from "./webRetrieve.js";
import { logger } from "./utils/index.js";

const { DicomMessage, DicomMetaDictionary } = dcmjs.data;

const log = logger.commandsLog;

/**
 * The dicomweb support classes for querying and reading various DICOMweb data sources
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
  const arrayBuffer = fs.readFileSync(fileName).buffer;
  const uncompressed = isGzip ? zlib.gunzipSync(arrayBuffer) : arrayBuffer;
  const str = uncompressed.toString();
  return JSON.parse(str);
}

export function getStudyQuery(wadoUrl, _options, forStudy) {
  const { StudyInstanceUID } = forStudy;
  console.log("Querying for study", StudyInstanceUID);
  return `${wadoUrl}?StudyInstanceUID=${StudyInstanceUID}`;
}

export function getSeriesQuery(wadoUrl, options, forStudy) {
  const { StudyInstanceUID } = forStudy;
  return `${wadoUrl}/studies/${StudyInstanceUID}/series`;
}

export async function queryDownloads(wadoUrl, options) {
  const StudyInstanceUID = options.study;
  const SeriesInstanceUID = options.series || [];
  const query = { StudyInstanceUID, SeriesInstanceUID };
  const studyQuery = getStudyQuery(wadoUrl, options);
  const study = await readDicomWeb(studyQuery)?.[0];
  const downloaded = [];
  if (!study) {
    log.warn("No study found for", options.study);
    return downloaded;
  }
  downloaded.push({
    relativePath: `studies/${StudyInstanceUID}`,
    data: [study],
  });

  const series = await readDicomWeb(getSeriesQuery(wadoUrl, options, query));
  log.debug("Found series", series);
  return [];
}

export function store(path, data, options) {
  log.info("Storing data", path);
  log.debug(JSON.stringify(data, null, 2));
}
