import fs from "fs";

import { commandsLog } from "../utils/logger.js";
import { DicomAccess } from "../access/DicomAccess.js";
import { StaticDicomWebStudy } from "./StaticDicomWebStudy.js";

const log = commandsLog.getLogger("StaticDicomWebAccess");

/**
 * Store to file based DICOMWeb layout
 */
export class StaticDicomWebAccess extends DicomAccess {
  createIfNeeded(options) {
    if (!options || options?.create) {
      log.debug("Creating destination static dicom web at:", this.url);
      fs.mkdirSync(this.url, { recursive: true });
    }
  }

  createAccess(studyUID, natural) {
    return new StaticDicomWebStudy(this, studyUID, natural);
  }
}

export default StaticDicomWebAccess;
