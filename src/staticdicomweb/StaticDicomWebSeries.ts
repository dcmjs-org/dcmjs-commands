import { saveJson, loadJson, naturalize, logger } from "../utils";
import { SeriesAccess } from "../access/DicomAccess";
import { StaticDicomWebInstance } from "./StaticDicomWebInstance";

const log = logger.commandsLog.getLogger("StaticDicomWeb", "Series");

export class StaticDicomWebSeries extends SeriesAccess {
  public async queryChildren() {
    if (this.childrenMap.size) {
      return [...this.childrenMap.values()];
    }
    const json = await loadJson(this.url, "metadata.gz");
    const naturalJson = naturalize(json);
    log.warn("There are", naturalJson.length, "instances in series", this.uid);
    return naturalJson.map((instance, idx) => {
      const newInstance = this.addJson(instance);
      newInstance.jsonData = json[idx];
      return newInstance;
    });
  }

  public async storeCurrentLevel(source) {
    const metadata = [];
    await source.forEach((instance) => {
      metadata.push(instance.jsonData);
    });
    if (!metadata.length) {
      log.warn(
        "Not storing series",
        this.uid,
        this.url,
        "as there are no instances"
      );
      return;
    }
    log.warn("Storing series with", metadata.length, "instances");
    await saveJson(this.url, "metadata.gz", metadata);
  }

  public createAccess(sopUID, natural?) {
    console.warn("Creating instance SDW access", sopUID, this.url);
    return new StaticDicomWebInstance(this, sopUID, natural);
  }
}
