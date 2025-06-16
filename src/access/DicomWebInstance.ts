import { logger } from "../utils";
import { InstanceAccess } from "../access/DicomAccess";

const log = logger.commandsLog.getLogger("DicomWeb", "Instance");

export class DicomWebInstance extends InstanceAccess {
  /** Opens the frame.  Options allow choosing to get compressed/encapsulated data back */
  public async openFrame(frame = 1, _options?) {
    console.warn("Opening frame", frame, "of", `${this.url}/frames/${frame}`);
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
}
