import {
  saveJson,
  loadJson,
  naturalize,
  denaturalize,
  logger,
} from "../utils/index.js";
import { StudyAccess } from "../access/DicomAccess.js";
import { StaticDicomWebSeries } from "./StaticDicomWebSeries.js";

const log = logger.commandsLog.getLogger("StaticDicomWebStudy");

export class StaticDicomWebStudy extends StudyAccess {
  /** Reads the study level index definition */
  async read() {
    const json = await loadJson(this.url, "index.json.gz", null);
    if (!json) {
      throw new Error(
        `${this.url}/index.json.gz not found — ` +
          `${this.dicomAccess.url} does not look like a Static-DICOMweb ` +
          `tree (no studies/<uid>/index.json.gz). A directory of Part 10 ` +
          `(.dcm) files is detected automatically; check the path and the ` +
          `StudyInstanceUID.`
      );
    }
    this.jsonData = json;
    this.natural = naturalize(json);
    log.debug("Read study normal data", !!this.natural);
  }

  // Save study-level metadata
  async storeCurrentLevel(source) {
    if (!source.jsonData) {
      throw new Error(
        `Unable to store at level ${this.name} source data ${source.uid} from ${source.url}`
      );
    }
    await saveJson(this.url, "index.json.gz", source.jsonData);
    log.info("Storing study json", !!source.natural);
    await saveJson(this.url, "study.json.gz", source.natural);
    log.info("Study metadata saved to", this.url, "index and study json.gz");
    const seriesQuery = [];
    for (const seriesAccess of this.childrenMap.values()) {
      const seriesData = seriesAccess.createSeriesQuery();
      seriesQuery.push(denaturalize(seriesData));
    }
    await saveJson(this.url, "series/index.json.gz", seriesQuery);
    log.debug("Series query saved to", this.url, "series/index.json.gz");
  }

  createAccess(seriesUID, natural) {
    log.debug("Creating access on seriesUID", seriesUID);
    return new StaticDicomWebSeries(this, seriesUID, natural);
  }

  async queryChildren() {
    if (this.childrenMap.size) {
      return [...this.childrenMap.values()];
    }
    const json = await loadJson(this.url, "series/index.json.gz");
    const naturalJson = naturalize(json);
    return naturalJson.map((series) => this.addJson(series));
  }
}
