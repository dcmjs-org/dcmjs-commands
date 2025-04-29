import * as dicomweb from "../dicomweb.js";
import { createDicomWebConfig, fixBulkDataURI } from "../utils/index.js";

const nonFrameSOPs = {
  "1.2.840.10008.5.1.4.1.1.88.11": "Basic Text SR",
  "1.2.840.10008.5.1.4.1.1.88.22": "Enhanced SR",
  "1.2.840.10008.5.1.4.1.1.88.33": "Comprehensive SR",
  "1.2.840.10008.5.1.4.1.1.481.3": "RT Structure Set",
  "1.2.840.10008.5.1.4.1.1.104.1": "Encapsulated PDF",
};

export class DicomWebSeries extends SeriesAccess {}
