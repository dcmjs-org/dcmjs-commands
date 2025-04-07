import * as dicomweb from "../dicomweb.js";
import { createDicomWebConfig, fixBulkDataURI } from "../utils/index.js";

const nonFrameSOPs = {
  "1.2.840.10008.5.1.4.1.1.88.11": "Basic Text SR",
  "1.2.840.10008.5.1.4.1.1.88.22": "Enhanced SR",
  "1.2.840.10008.5.1.4.1.1.88.33": "Comprehensive SR",
  "1.2.840.10008.5.1.4.1.1.481.3": "RT Structure Set",
  "1.2.840.10008.5.1.4.1.1.104.1": "Encapsulated PDF",
};

export class DicomWebSeriesAccess {
  constructor(url, options, metadata) {
    this.url = url;
    this.options = options;
    this.StudyInstanceUID = options.StudyInstanceUID;
    this.metadata = metadata;

    // Containers to store queried data
    this.seriesInstanceUIDsMetadata = new Map();
    this.seriesInstanceUIDsInstances = new Map();
    this.seriesInstanceUIDsFrames = new Map();
    this.seriesInstanceUIDsBulkData = new Map();
  }

  getMetadata() {
    return this.metadata;
  }

  async querySeriesInstanceUIDsMetadata() {
    console.log("📄 Fetching metadata for each series...");
    for (const serie of this.metadata) {
      const SeriesInstanceUID = serie["0020000E"]?.Value?.[0];
      if (!SeriesInstanceUID) continue;

      const wadoURL = `${this.url}/studies/${this.StudyInstanceUID}/series/${SeriesInstanceUID}/metadata`;
      console.log(`   ↪️ Fetching metadata for series ${SeriesInstanceUID}`);
      const data = await dicomweb.readDicomWeb(wadoURL);
      this.seriesInstanceUIDsMetadata.set(SeriesInstanceUID, data);
    }
  }

  async querySeriesInstanceUIDsInstances() {
    console.log("📦 Fetching instances for each series...");
    for (const serie of this.metadata) {
      const SeriesInstanceUID = serie["0020000E"]?.Value?.[0];
      if (!SeriesInstanceUID) continue;

      const wadoURL = `${this.url}/studies/${this.StudyInstanceUID}/series/${SeriesInstanceUID}/instances`;
      console.log(`   ↪️ Fetching instances for series ${SeriesInstanceUID}`);
      const data = await dicomweb.readDicomWeb(wadoURL);
      this.seriesInstanceUIDsInstances.set(SeriesInstanceUID, data);
    }
  }

  async querySeriesInstanceUIDsFrames() {
    console.log("🖼️  Fetching frames for multi-frame instances...");
    for (const [SeriesInstanceUID, instances] of this
      .seriesInstanceUIDsInstances) {
      const seriesMetadata =
        this.seriesInstanceUIDsMetadata.get(SeriesInstanceUID);

      const metadataMap = Object.fromEntries(
        seriesMetadata.map((item) => [
          item["00080018"]?.Value?.[0], // SOPInstanceUID
          item["00080016"]?.Value?.[0], // SOPClassUID
        ]),
      );

      const frames = [];

      for (const instance of instances) {
        const sopInstanceUID = instance["00080018"]?.Value?.[0];
        const numberOfFrames = instance["00280008"]?.Value?.[0] || 1;
        const sopClassUID = metadataMap[sopInstanceUID];

        if (!sopInstanceUID || !sopClassUID || nonFrameSOPs[sopClassUID])
          continue;

        console.log(
          `   ↪️ Fetching ${numberOfFrames} frame(s) for instance ${sopInstanceUID}`,
        );
        for (
          let frameNumber = 1;
          frameNumber <= numberOfFrames;
          frameNumber++
        ) {
          const wadoURL = `${this.url}/studies/${this.StudyInstanceUID}/series/${SeriesInstanceUID}/instances/${sopInstanceUID}/frames/${frameNumber}`;
          const data = await dicomweb.readDicomWeb(wadoURL);
          if (data?.error || data?.statusCode === 403) {
            console.warn(`     ⚠️ Skipped frame ${frameNumber} (error or 403)`);
            continue;
          }
          frames.push({ data, frameNumber, sopInstanceUID });
        }
      }

      this.seriesInstanceUIDsFrames.set(SeriesInstanceUID, frames);
    }
  }

  async querySeriesInstanceUIDsBulkData() {
    console.log("🧱 Fetching referenced bulk data...");
    const dicomWebConfig = createDicomWebConfig({ dicomwebUrl: this.url });

    for (const [SeriesInstanceUID, seriesMetadata] of this
      .seriesInstanceUIDsMetadata) {
      const bulkDataItems = [];

      for (const metadataItem of seriesMetadata) {
        const sopInstanceUID = metadataItem["00080018"]?.Value?.[0];

        for (const tag in metadataItem) {
          if (tag === "7FE00010") continue;
          const tagValue = metadataItem[tag];

          if (tagValue?.BulkDataURI) {
            fixBulkDataURI(
              tagValue,
              { StudyInstanceUID: this.StudyInstanceUID, SeriesInstanceUID },
              dicomWebConfig,
            );
            const wadoURL = tagValue.BulkDataURI;
            console.log(`   ↪️ Fetching bulk data from ${wadoURL}`);
            const data = await dicomweb.readDicomWeb(wadoURL);
            if (data?.error || data?.statusCode === 403) {
              console.warn(
                `     ⚠️ Skipped bulk data tag ${tag} (error or 403)`,
              );
              continue;
            }
            bulkDataItems.push({ data, sopInstanceUID, tag, wadoURL });
          }
        }
      }

      this.seriesInstanceUIDsBulkData.set(SeriesInstanceUID, bulkDataItems);
    }
  }
}
