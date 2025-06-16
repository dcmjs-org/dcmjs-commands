import { SeriesAccess } from "../access/DicomAccess";
import { naturalize, logger } from "../utils";
import { DicomWebInstance } from "./DicomWebInstance";

const log = logger.commandsLog.getLogger("StaticDicomWeb", "Series");

export class DicomWebSeries extends SeriesAccess {
  public async queryChildren() {
    if (this.childrenMap.size) {
      return [...this.childrenMap.values()];
    }
    const json = await this.dicomAccess.client.retrieveSeriesMetadata({
      studyInstanceUID: this.parent.uid,
      seriesInstanceUID: this.uid,
    });
    console.warn("instanceData #", json.length);
    const naturalJson = naturalize(json);
    console.warn(
      "There are",
      naturalJson.length,
      "instances in series",
      this.uid
    );
    return [
      ...naturalJson.map((instance, idx) => {
        log.trace("Adding instance", instance);
        const newInstance = this.addJson(instance);
        newInstance.jsonData = json[idx];
        return newInstance;
      }),
    ];
  }

  public createAccess(sopUID, natural?) {
    log.trace("Creating instance DW access", sopUID, this.url, natural);
    return new DicomWebInstance(this, sopUID, natural);
  }
}
