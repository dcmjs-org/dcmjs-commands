// src/part10/Part10Instance.js

import { InstanceAccess } from "../access/DicomAccess.js";
import {
  extractFrame,
  contentTypeForTransferSyntax,
} from "./part10ToDicomWebJson.js";

export class Part10Instance extends InstanceAccess {
  /**
   * One return shape serves both callers: the Static-DICOMweb destination
   * ({compressed:true, encapsulated:true} — it writes the multipart
   * wrapper itself when encapsulated is false), and the part10 round-trip
   * path ({buffer:true} — frameToBuffer passes objects with .buffer
   * through unchanged).
   */
  async openFrame(frame = 1, _options) {
    const { entry } = this;
    const pixelValue = this.dicomAccess.readPixelValue(entry.filePath);
    const buffer = extractFrame(pixelValue, frame, entry);
    return {
      buffer,
      compressed: false,
      encapsulated: false,
      contentType: entry.frameInfo.encapsulated
        ? contentTypeForTransferSyntax(entry.transferSyntaxUID)
        : "application/octet-stream",
      transferSyntaxUID: entry.transferSyntaxUID,
    };
  }

  async openBulkdata(key, jsonNode, _options) {
    const buffer = this.entry.bulkdataMap.get(jsonNode?.BulkDataURI);
    if (!buffer) {
      throw new Error(
        `no bulkdata recorded for tag ${key} ` +
          `(${jsonNode?.BulkDataURI}) in ${this.entry.filePath}`
      );
    }
    return {
      buffer,
      compressed: false,
      encapsulated: false,
      contentType: "application/octet-stream",
      transferSyntaxUID: "1.2.840.10008.1.2.1",
    };
  }
}
