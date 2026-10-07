import DICOMwebClient from "dicomweb-client";

import { DicomAccess } from "./DicomAccess.js";
import { DicomWebStudy } from "./DicomWebStudy.js";
import { commandsLog } from "../utils/logger.js";

const log = commandsLog.getLogger("DicomWebAccess");

/**
 * dicomweb-client is XHR-based; provide an XMLHttpRequest for Node.
 * jsdom is heavy, so it loads lazily: this module is only dynamically
 * imported by DicomAccess.createInstance for http(s) schemes, so file-based
 * and CLI-only use never pays for it. (An xhr2 replacement was spiked and
 * returned empty QIDO results against a live server, so jsdom stays until
 * dicomweb-client drops XHR.)
 */
if (!globalThis.XMLHttpRequest) {
  const { JSDOM } = await import("jsdom");
  const jsdomDoc = new JSDOM(``);
  globalThis.window = jsdomDoc.window;
  globalThis.XMLHttpRequest = jsdomDoc.window.XMLHttpRequest;
}

export class DicomWebAccess extends DicomAccess {
  constructor(url, options) {
    super(url, options);
    log.debug("Creating DicomWebAccess for", url);
    this.client = new DICOMwebClient.api.DICOMwebClient({
      url,
      // e.g. { Authorization: `Bearer ...` } — dicomweb-client adds these
      // to every request (SMART Imaging Access reuses the FHIR token).
      headers: options?.headers,
      verbose: false,
    });
    log.debug("Created DICOMwebclient api", !!this.client);
  }

  createAccess(studyUID, natural) {
    return new DicomWebStudy(this, studyUID, natural);
  }
}

export default DicomWebAccess;
