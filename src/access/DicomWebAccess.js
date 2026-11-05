import { DicomAccess } from "./DicomAccess.js";
import { DicomWebFetch } from "./DicomWebFetch.js";
import { DicomWebStudy } from "./DicomWebStudy.js";
import { commandsLog } from "../utils/logger.js";

const log = commandsLog.getLogger("DicomWebAccess");

export class DicomWebAccess extends DicomAccess {
  constructor(url, options) {
    super(url, options);
    log.debug("Creating DicomWebAccess for", url);
    // headers, e.g. { Authorization: `Bearer ...` }, go on every request
    // (SMART Imaging Access reuses the FHIR token).
    this.client = new DicomWebFetch({ url, headers: options?.headers });
  }

  createAccess(studyUID, natural) {
    return new DicomWebStudy(this, studyUID, natural);
  }
}

export default DicomWebAccess;
