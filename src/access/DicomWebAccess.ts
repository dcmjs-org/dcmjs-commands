import { DicomAccess } from "./DicomAccess";
import { DicomWebStudy } from "./DicomWebStudy";
import * as dicomweb from "../dicomweb";
import { commandsLog } from "../utils/logger";
import fs from "fs";

const log = commandsLog.getLogger("DicomWebAccess");

function updateUrl(url) {
  const noScheme = url.startsWith("sdw:") ? url.substring(4) : url;
  const withStudies = url.contains("/studies")
    ? noScheme
    : `${noScheme}/studies`;
  fs.mkdirSync(withStudies, { recursive: true });
  return withStudies;
}

export class DicomWebAccess extends DicomAccess {
  constructor(url, options) {
    super(updateUrl(url), options);
    log.warn("Hello DicomWebAccess", url);
  }

  // Fetch study-level metadata from DICOMweb
  async queryStudy(studyUID: string) {
    const wadoURL = `${this.url}/studies/${studyUID}`;
    log.info(`🔍 Fetching study metadata from ${wadoURL}`);
    const data = await dicomweb.readDicomWeb(wadoURL);
    return new DicomWebStudy(this.url, this.options, data);
  }

  // // Fetch all series metadata for the study
  // async querySeries() {
  //   const wadoURL = `${this.url}/studies/${this.StudyInstanceUID}/series`;
  //   log.info(`🔍 Fetching series list from ${wadoURL}`);
  //   const data = await dicomweb.readDicomWeb(wadoURL);
  //   return new DicomWebSeries(this.url, this.options, data);
  // }
}

export default DicomWebAccess;
