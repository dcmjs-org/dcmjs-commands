import { saveJson, loadJson, naturalize, logger } from "../utils";
import { InstanceAccess } from "../access/DicomAccess";

const log = logger.commandsLog.getLogger("StaticDicomWeb", "Series");

export class StaticDicomWebInstance extends InstanceAccess {
  public async storeCurrentLevel(source: InstanceAccess): void {
    if (!source.jsonData) {
      throw new Error(`No json data for instance ${source.uid}`);
    }
    log.warn(
      "Storing instance access",
      source.uid,
      "to destination with jsonData"
    );

    this.jsonData = structuredClone(source.jsonData);

    // TODO - extract bulkdata copies
  }
}
