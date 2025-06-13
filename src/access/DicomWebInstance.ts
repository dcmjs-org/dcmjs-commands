import { logger } from "../utils";
import { InstanceAccess } from "../access/DicomAccess";
import fsBase from "fs";

const log = logger.commandsLog.getLogger("DicomWeb", "Instance");

export class DicomWebInstance extends InstanceAccess {
  /** Opens the frame.  Options allow choosing to get compressed/encapsulated data back */
  public async openFrame(frame = 1, _options?) {
    const path = `${this.url}/frames/${frame}.mht`;
    if (fsBase.existsSync(path)) {
      log.debug("Getting uncompressed but encapsulated");
      return {
        stream: await fsBase.createReadStream(path),
        compressed: false,
        encapsulated: true,
      };
    }
    const gzPath = `${path}.gz`;
    if (fsBase.existsSync(gzPath)) {
      log.debug("Get compressed and encapsulated data");
      return {
        stream: await fsBase.createReadStream(gzPath),
        compressed: true,
        encapsulated: true,
      };
    }
    console.warn("No frame file found for", this.url, frame);
  }
}
