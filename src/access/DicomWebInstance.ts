import { logger } from "../utils";
import { InstanceAccess } from "../access/DicomAccess";
import { multipartDecode } from "../utils/message";

const log = logger.commandsLog.getLogger("DicomWeb", "Instance");

export class DicomWebInstance extends InstanceAccess {
  /** Opens the frame.  Options allow choosing to get compressed/encapsulated data back */
  public async openFrame(frame = 1, _options?) {
    const frames = await this.dicomAccess.client.retrieveInstanceFrames({
      ..._options,
      studyInstanceUID: this.parent.parent.uid,
      seriesInstanceUID: this.parent.uid,
      sopInstanceUID: this.uid,
      frameNumbers: frame,
    });
    return {
      buffer: frames[0],
      contentType: frames[0].contentType,
      transferSyntaxUID: frames[0].transferSyntaxUID,
      compressed: false,
    };
  }

  public async openBulkdata(key, child, _options) {
    let bulkDataURI = child.BulkDataURI;
    // Handle static DICOMweb references, allowed but not supported by the dicomweb
    // library.  Other relative references will have to be fixed/handled later.
    if (bulkDataURI.startsWith("bulkdata/")) {
      bulkDataURI = `${this.parent.parent.url}/${bulkDataURI}`;
    }
    const bulk = await this.dicomAccess.client.retrieveBulkData({
      studyInstanceUID: this.parent.parent.uid,
      BulkDataURI: bulkDataURI,
    });
    const decoded = multipartDecode(bulk[0]);
    if (decoded) {
      return {
        buffer: decoded[0],
        encapsulated: false,
        compressed: false,
      };
    }
    return {
      buffer: bulk[0],
      encapsulated: false,
      compressed: false,
    };
  }
}
