import DICOMwebClient from "dicomweb-client";

import { DicomAccess } from "./DicomAccess";
import { DicomWebStudy } from "./DicomWebStudy";
import { commandsLog } from "../utils/logger";

const log = commandsLog.getLogger("DicomWebAccess");

export class DicomWebAccess extends DicomAccess {
  constructor(url, options) {
    super(url, options);
    log.warn("Hello DicomWebAccess", url);
    this.client = new DICOMwebClient.api.DICOMwebClient({
      url,
      verbose: false,
    });
    log.warn("Created DICOMwebclient api", !!this.client);
  }

  public createAccess(studyUID: string, natural?: StudyNatural) {
    return new DicomWebStudy(this, studyUID, natural);
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
