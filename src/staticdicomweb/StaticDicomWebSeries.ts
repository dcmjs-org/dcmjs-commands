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
    log.info("There are", naturalJson.length, "instances in series", this.uid);
    return [
      ...naturalJson.map((instance, idx) => {
        const newInstance = this.addJson(instance);
        newInstance.jsonData = json[idx];
        return newInstance;
      }),
    ];
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
    log.info("Storing series with", metadata.length, "instances");
    await saveJson(this.url, "metadata.gz", metadata);

    const seriesQuery = this.createSeriesQuery();
    await saveJson(this.url, "series-singleton.json.gz", seriesQuery);

    const naturalSeriesQuery = naturalize(seriesQuery);
    this.addInstanceNaturalQuery(naturalSeriesQuery);
    await saveJson(this.url, "series-natural.json.gz", naturalSeriesQuery);

    const instanceQuery = [
      ...this.childrenMap
        .values()
        .map((instance) => instance.createInstanceQuery()),
    ];
    await saveJson(this.url, "index.json.gz", instanceQuery);
  }

  public createAccess(sopUID, natural?) {
    log.trace("Creating instance SDW access", sopUID, this.url);
    return new StaticDicomWebInstance(this, sopUID, natural);
  }
}
