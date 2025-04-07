import { DicomAccess } from "./DicomAccess.js";
import { DicomWebStudyAccess } from "./DicomWebStudyAccess.js";
import { DicomWebSeriesAccess } from "./DicomWebSeriesAccess.js";
import * as dicomweb from "../dicomweb.js";

export class DicomWebAccess extends DicomAccess {
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.StudyInstanceUID = options.StudyInstanceUID;
  }

  // Fetch study-level metadata from DICOMweb
  async queryStudy() {
    const wadoURL = `${this.url}/studies/${this.StudyInstanceUID}`;
    console.log(`🔍 Fetching study metadata from ${wadoURL}`);
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
