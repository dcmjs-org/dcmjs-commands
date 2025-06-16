import { saveJson, loadJson, naturalize, logger } from "../utils";
import { StudyAccess, SeriesAccess } from "../access/DicomAccess";
import { StaticDicomWebSeries } from "./StaticDicomWebSeries";
import { denaturalize } from "../utils";

const log = logger.commandsLog.getLogger("StaticDicomWebStudy");

export class StaticDicomWebStudy extends StudyAccess {
  /** Reads the study level index definition */
  public async read() {
    const json = await loadJson(this.url, "index.json.gz");
    this.jsonData = json;
    this.natural = naturalize(json);
    log.debug("Read study normal data", !!this.natural);
  }

  // Save study-level metadata
  async storeCurrentLevel(source: StudyAccess) {
    if (!source.jsonData) {
      throw new Error(
        `Unable to store at level ${this.name} source data ${source.uid} from ${source.url}`
      );
    }
    await saveJson(this.url, "index.json.gz", source.jsonData);
    console.info("Storing study json", !!source.natural);
    await saveJson(this.url, "study.json.gz", source.natural);
    log.info("Study metadata saved to", this.url, "index and study json.gz");
    const seriesQuery = [];
    for (const seriesAccess of this.childrenMap.values()) {
      const seriesData = seriesAccess.createSeriesQuery();
      seriesQuery.push(denaturalize(seriesData));
    }
    console.warn(
      "Series query saved to",
      this.url,
      "series/index.json.gz",
      !!seriesQuery
    );
    await saveJson(this.url, "series/index.json.gz", seriesQuery);
    console.warn("Done storing current level is study");
  }

  public createAccess(sopUID: string, natural) {
    log.debug("Creating access on sopUID", sopUID);
    return new StaticDicomWebSeries(this, sopUID, natural);
  }

  public async queryChildren(): Promise<SeriesAccess[]> {
    if (this.childrenMap.size) {
      return [...this.childrenMap.values()];
    }
    const json = await loadJson(this.url, "series/index.json.gz");
    const naturalJson = naturalize(json);
    return naturalJson.map((series) => this.addJson(series));
  }
}
