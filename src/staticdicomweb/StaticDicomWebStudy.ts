import { saveJson, loadJson, naturalize, logger } from "../utils";
import { StudyAccess, SeriesAccess } from "../access/DicomAccess";
import { StaticDicomWebSeries } from "./StaticDicomWebSeries";

const log = logger.commandsLog.getLogger("StaticDicomWebStudy");

export class StaticDicomWebStudy extends StudyAccess {
  /** Reads the study level index definition */
  public async read() {
    const json = await loadJson(this.url, "index.json.gz");
    this.jsonData = json;
    this.natural = naturalize(json);
    log.warn("Read study normal data", !!this.natural);
  }

  // Save study-level metadata
  async storeCurrentLevel(source: StudyAccess) {
    await saveJson(this.url, "index.json.gz", source.jsonData);
    await saveJson(this.url, "study.json.gz", source.natural);
    console.warn(
      "Study metadata saved to",
      this.url,
      "index and study json.gz"
    );
  }

  public createAccess(sopUID: string, natural) {
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
