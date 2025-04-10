import fs from "fs";

import { commandsLog } from "../utils/logger";
import { StudyAccess } from "../access/DicomAccess";

const log = commandsLog.getLogger("StaticDicomWebAccess");

/**
 * Store to file based DICOMWeb layout
 */
export class StaticDicomWebAccess extends StudyAccess {
  constructor(url, options) {
    super(url, options);
  }

  async queryStudy(studyInstanceUID) {
    const path = `${this.url}/${studyInstanceUID}`;
    fs.mkdir(this.url, { recursive: true });
    return new StaticDicomWebStudy(this, studyInstanceUID);
  }

  public store = async (study, _options) => {
    const destStudy = this.add(study);

    // Fetch series metadata
    log.info("📚 Querying series metadata...");
    for (const series of await study.querySeries()) {
      log.info("Got series", series.seriesInstanceUID);
      const destSeries = destStudy.add(series);
      const instances = await series.query();
      for (const instance of instances) {
        log.info("Got instance", instance.sopInstanceUID);
        const destInstance = destSeries.add(instance);
        // Have to store bulkdata first to update references in local copy
        await destInstance.storeBulkdata(instance);
        // This will be a no-op if not an image instance
        // For video instances, it will store rendered response
        await destInstance.storeFrames(instance);
        await destInstance.storeThumbnail(instance);
      }
      await destSeries.storeMetadata(series);
      await destSeries.storeIndex(series);
    }
    await destStudy.storeIndex();

    return destStudy;
  };
}

export default StaticDicomWebAccess;
