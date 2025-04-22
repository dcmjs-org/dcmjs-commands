import fs from "fs/promises";
import crypto from "crypto";
import { saveJson, loadJson, naturalize, logger } from "../utils";
import { StudyAccess, SeriesAccess } from "../access/DicomAccess";
import { StaticDicomWebSeries } from "./StaticDicomWebSeries";

const log = logger.commandsLog.getLogger("StaticDicomWebStudy");

export class StaticDicomWebStudy extends StudyAccess {
  /** Reads the study level index definition */
  public async read() {
    const json = await loadJson(this.url, "index.json.gz");
    this.studyJson = json;
    this.studyNormal = naturalize(json);
    log.warn("Read study normal data", !!this.studyNormal);
  }

  // Save study-level metadata
  async storeStudyData(source: StudyAccess) {
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

  public store(source) {
    console.warn("Storing uid=", source.uid, "to", this.url);
  }

  public async queryChildren(): Promise<SeriesAccess[]> {
    if (this.childrenMap.size) {
      return [...this.childrenMap.values()];
    }
    const json = await loadJson(this.url, "series/index.json.gz");
    const naturalJson = naturalize(json);
    return naturalJson.map((series) => this.addJson(series));
  }

  // Save non-pixel bulk data blobs into hashed folders
  async #storeBulkData(path, seriesAccess) {
    for (const [_, bulkDataItems] of seriesAccess.seriesInstanceUIDsBulkData) {
      for (const item of bulkDataItems) {
        const uri = item.wadoURL;

        // Hash the URI to generate a safe, consistent path
        const hash = crypto.createHash("sha256").update(uri).digest("hex");
        const folder = `${path}/bulkdata/${hash.substring(0, 3)}/${hash.substring(3, 5)}`;
        await fs.mkdir(folder, { recursive: true });

        const filename = `${hash}.json`;
        const fullPath = `${folder}/${filename}`;

        // Convert binary to base64 to safely store in JSON
        const base64 = Buffer.isBuffer(item.data)
          ? item.data.toString("base64")
          : Buffer.from(item.data).toString("base64");

        await saveJson(fullPath, { data: base64 });
        console.log(
          `🧱 Bulk data (${item.tag}) from instance ${item.sopInstanceUID} saved.`
        );
      }
    }
  }
}
