import { DicomAccess } from "./DicomAccess";
import { DicomWebStudyAccess } from "./DicomWebStudyAccess";
import { DicomWebSeriesAccess } from "./DicomWebSeriesAccess";
import * as dicomweb from "../dicomweb";
import { commandsLog } from "../utils/logger";

const log = commandsLog.getLogger("DicomWebAccess");

export class DicomWebAccess extends DicomAccess {
  constructor(url, options) {
    super(url, options);
    log.warn("Hello DicomWebAccess", url);
  }

  // Fetch study-level metadata from DICOMweb
  async queryStudy() {
    const wadoURL = `${this.url}/studies/${this.StudyInstanceUID}`;
    log.info(`🔍 Fetching study metadata from ${wadoURL}`);
    const data = await dicomweb.readDicomWeb(wadoURL);
    return new DicomWebStudyAccess(this.url, this.options, data);
  }

  // Fetch all series metadata for the study
  async querySeries() {
    const wadoURL = `${this.url}/studies/${this.StudyInstanceUID}/series`;
    console.log(`🔍 Fetching series list from ${wadoURL}`);
    const data = await dicomweb.readDicomWeb(wadoURL);
    return new DicomWebSeriesAccess(this.url, this.options, data);
  }
}

export default DicomWebAccess;
