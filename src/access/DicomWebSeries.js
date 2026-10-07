import { SeriesAccess } from "../access/DicomAccess.js";
import { naturalize, logger } from "../utils/index.js";
import { DicomWebInstance } from "./DicomWebInstance.js";

const log = logger.commandsLog.getLogger("DicomWeb", "Series");

export class DicomWebSeries extends SeriesAccess {
  async queryChildren() {
    if (this.childrenMap.size) {
      return [...this.childrenMap.values()];
    }
    const json = await this.dicomAccess.client.retrieveSeriesMetadata({
      studyInstanceUID: this.parent.uid,
      seriesInstanceUID: this.uid,
    });
    const naturalJson = naturalize(json);
    log.info("There are", naturalJson.length, "instances in series", this.uid);
    return [
      ...naturalJson.map((instance, idx) => {
        log.trace("Adding instance", instance);
        const newInstance = this.addJson(instance);
        newInstance.jsonData = json[idx];
        return newInstance;
      }),
    ];
  }

  createAccess(sopUID, natural) {
    log.trace("Creating instance DW access", sopUID, this.url, natural);
    return new DicomWebInstance(this, sopUID, natural);
  }
}
