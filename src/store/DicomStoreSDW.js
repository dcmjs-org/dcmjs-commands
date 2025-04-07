import fs from "fs/promises";
import crypto from "crypto";
import { saveJson } from "../utils/index.js";
import { DicomStoreAccess } from "./DicomStoreAccess.js";

export class DicomStoreSDW extends DicomStoreAccess {
  // Store all study-related content to the local SDW structure
  async store(path, studyAccess, seriesAccess) {
    console.log("💾 Saving study metadata...");
    await this.#storeStudy(path, studyAccess);

    console.log("💾 Saving series metadata...");
    await this.#storeSeries(path, seriesAccess);

    console.log("💾 Saving instances...");
    await this.#storeInstances(path, seriesAccess);

    console.log("💾 Saving frames...");
    await this.#storeFrames(path, seriesAccess);

    console.log("💾 Saving bulk data...");
    await this.#storeBulkData(path, seriesAccess);
  }

  // Save study-level metadata
  async #storeStudy(path, studyAccess) {
    await fs.mkdir(path, { recursive: true });
    await saveJson(`${path}/index.json`, studyAccess.getMetadata());
    console.log("✅ Study metadata saved.");
  }

  // Save series-level metadata and organize by SeriesInstanceUID
  async #storeSeries(path, seriesAccess) {
    const seriesPath = `${path}/series`;
    await fs.mkdir(seriesPath, { recursive: true });
    await saveJson(`${seriesPath}/index.json`, seriesAccess.getMetadata());

    for (const series of seriesAccess.getMetadata()) {
      const SeriesInstanceUID = series["0020000E"]?.Value?.[0];
      if (!SeriesInstanceUID) continue;

      const seriesDir = `${seriesPath}/${SeriesInstanceUID}`;
      await fs.mkdir(seriesDir, { recursive: true });
      await saveJson(`${seriesDir}/metadata`, series);
      console.log(`📁 Series ${SeriesInstanceUID} metadata saved.`);
    }
  }

  // Save all DICOM instances organized by series and instance UID
  async #storeInstances(path, seriesAccess) {
    for (const [
      SeriesInstanceUID,
      instances,
    ] of seriesAccess.seriesInstanceUIDsInstances) {
      const seriesMetadata =
        seriesAccess.seriesInstanceUIDsMetadata.get(SeriesInstanceUID);

      const metadataMap = Object.fromEntries(
        seriesMetadata.map((item) => [item["00080018"]?.Value?.[0], item]),
      );

      const instancesDir = `${path}/series/${SeriesInstanceUID}/instances`;
      await fs.mkdir(instancesDir, { recursive: true });

      const instanceUIDs = [];

      for (const instance of instances) {
        const sopInstanceUID = instance["00080018"]?.Value?.[0];
        if (!sopInstanceUID) continue;

        instanceUIDs.push(sopInstanceUID);
        const instanceDir = `${instancesDir}/${sopInstanceUID}`;
        await fs.mkdir(instanceDir, { recursive: true });

        const instanceMetadata = metadataMap[sopInstanceUID];
        if (instanceMetadata) {
          await saveJson(`${instanceDir}/index.json`, instanceMetadata);
          console.log(`📄 Instance ${sopInstanceUID} metadata saved.`);

          // Save additional metadata if instance contains frames
          const hasFrames = seriesAccess.seriesInstanceUIDsFrames
            .get(SeriesInstanceUID)
            ?.some((frame) => frame.sopInstanceUID === sopInstanceUID);
          if (hasFrames) {
            const metadataDir = `${instanceDir}/metadata`;
            await fs.mkdir(metadataDir, { recursive: true });
            await saveJson(`${metadataDir}/index.json`, instanceMetadata);
            console.log(`🖼️  Frame metadata for ${sopInstanceUID} saved.`);
          }
        }
      }

      await saveJson(`${instancesDir}/index.json`, instanceUIDs);
    }
  }

  // Save pixel data frames to disk
  async #storeFrames(path, seriesAccess) {
    for (const [
      SeriesInstanceUID,
      frames,
    ] of seriesAccess.seriesInstanceUIDsFrames) {
      const seriesDir = `${path}/series/${SeriesInstanceUID}`;
      for (const frame of frames) {
        const instanceDir = `${seriesDir}/instances/${frame.sopInstanceUID}`;
        const framesDir = `${instanceDir}/frames`;
        await fs.mkdir(framesDir, { recursive: true });

        const framePath = `${framesDir}/${frame.frameNumber}`;
        await fs.writeFile(framePath, frame.data?.buffer || frame.data);
        console.log(
          `🖼️  Frame ${frame.frameNumber} of instance ${frame.sopInstanceUID} saved.`,
        );
      }
    }
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
          `🧱 Bulk data (${item.tag}) from instance ${item.sopInstanceUID} saved.`,
        );
      }
    }
  }
}
