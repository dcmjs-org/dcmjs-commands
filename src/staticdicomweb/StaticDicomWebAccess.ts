import fs from "fs";

import { commandsLog } from "../utils/logger";
import { DicomAccess } from "../access/DicomAccess";
import { StaticDicomWebStudy } from "./StaticDicomWebStudy";

const log = commandsLog.getLogger("StaticDicomWebAccess");

/**
 * Store to file based DICOMWeb layout
 */
export class StaticDicomWebAccess extends DicomAccess {
  constructor(url: string, options) {
    super(url, options);
  }

  public createIfNeeded(options) {
    if (!options || options?.create) {
      log.warn("Creating destination static dicom web at:", this.url);
      fs.mkdirSync(this.url, { recursive: true });
    }
  }

  public createAccess(studyUID: string) {
    return new StaticDicomWebStudy(this, studyUID);
  }
}

export default StaticDicomWebAccess;
