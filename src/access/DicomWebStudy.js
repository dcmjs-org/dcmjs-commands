import { StudyAccess } from "../access/DicomAccess.js";
import { naturalize, logger } from "../utils/index.js";
import { DicomWebSeries } from "./DicomWebSeries.js";

const log = logger.commandsLog.getLogger("DicomWeb", "Study");

export class DicomWebStudy extends StudyAccess {
  async read() {
    log.info("Querying dicomweb for study", this.uid);
    try {
      const json = await this.dicomAccess.client.searchForStudies({
        queryParams: {
          studyInstanceUID: this.uid,
        },
      });
      log.info("Read study query result", json?.length);
      if (json) {
        this.jsonData = json;
        this.natural = naturalize(json);
        return;
      }
    } catch (e) {
      // Retrieve-only WADO-RS services (e.g. SMART Imaging Access
      // Endpoints) offer /studies/{uid}/... but no study-level QIDO.
      // The study identity is the UID we were asked for, so continue
      // with that and let the per-study series search drive the walk.
      log.warn(
        "Study-level QIDO unavailable at",
        this.dicomAccess.url,
        "- continuing retrieve-only:",
        e.message
      );
    }
    this.jsonData = [{ "0020000D": { vr: "UI", Value: [this.uid] } }];
    this.natural = naturalize(this.jsonData);
  }

  createAccess(seriesUID, natural) {
    log.debug("Creating access on seriesUID", seriesUID);
    return new DicomWebSeries(this, seriesUID, natural);
  }

  async queryChildren() {
    if (this.childrenMap.size) {
      return [...this.childrenMap.values()];
    }
    log.info("About to query for series in study", this.uid);
    const json = await this.dicomAccess.client.searchForSeries({
      studyInstanceUID: this.uid,
    });
    const naturalJson = naturalize(json);
    log.debug("Found series count=", naturalJson.length);
    return naturalJson.map((series) => this.addJson(series));
  }
}
