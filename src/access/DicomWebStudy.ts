import { StudyAccess } from "./DicomAccess";
import { logger } from "../utils";
import "../utils/XMLHttpRequest";

const log = logger.commandsLog.getLogger("DicomWeb", "Study");

export class DicomWebStudy extends StudyAccess {
  constructor(parent, uid, natural) {
    super(parent, uid, natural);
  }

  public async read() {
    const json = await this.dicomAccess.client.searchForStudies({
      queryParams: {
        StudyInstanceUID: this.uid,
      },
    });
    log.warn("Read json result", json);
    if (!json) {
      throw new Error(`No study results found for ${this.uid}`);
    }
  }
}
