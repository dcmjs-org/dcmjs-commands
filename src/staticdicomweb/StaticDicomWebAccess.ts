import fs from "fs";

import { commandsLog } from "../utils/logger";
import { DicomAccess } from "../access/DicomAccess";
import { StaticDicomWebStudy } from "./StaticDicomWebStudy";
import { StudyNatural } from "../access/DicomWebTypes";

const log = commandsLog.getLogger("StaticDicomWebAccess");

/**
 * Store to file based DICOMWeb layout
 */
export class StaticDicomWebAccess extends DicomAccess {
  public createIfNeeded(options) {
    if (!options || options?.create) {
      log.debug("Creating destination static dicom web at:", this.url);
      fs.mkdirSync(this.url, { recursive: true });
    }
  }

  public createAccess(studyUID: string, natural?: StudyNatural) {
    return new StaticDicomWebStudy(this, studyUID, natural);
  }
}

export default StaticDicomWebAccess;
