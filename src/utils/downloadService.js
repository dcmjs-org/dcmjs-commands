import fs from "fs";
import crypto from "crypto";
import { fixBulkDataURI, saveJson } from "./index.js";
import * as dicomweb from "../dicomweb.js";

export async function downloadBulkData(
  metadataItem,
  { options, studyUID, seriesUID, dicomWebConfig, bulkdataPath },
) {
  for (const tag in metadataItem) {
    if (tag === "7FE00010") continue;

    const tagValue = metadataItem[tag];
    if (tagValue && typeof tagValue === "object" && tagValue.BulkDataURI) {
      fixBulkDataURI(
        tagValue,
        {
          StudyInstanceUID: studyUID,
          SeriesInstanceUID: seriesUID,
        },
        dicomWebConfig,
      );

      const uri = tagValue.BulkDataURI;
      const hash = crypto.createHash("sha256").update(uri).digest("hex");
      const folder = `${bulkdataPath}/${hash.substring(0, 3)}/${hash.substring(3, 5)}`;
      const filename = `${hash}.json`;
      const bulkFullPath = `${folder}/${filename}`;

      try {
        fs.mkdirSync(folder, { recursive: true });
        const bulkdata = await dicomweb.readDicomWeb(uri, options);
        const base64 = Buffer.isBuffer(bulkdata)
          ? bulkdata.toString("base64")
          : Buffer.from(bulkdata).toString("base64");

        saveJson(bulkFullPath, { data: base64 }, options.zipJson);

        metadataItem[tag].BulkDataURI =
          `bulkdata/${hash.substring(0, 3)}/${hash.substring(3, 5)}/${filename}`;
        console.log(
          `✅ Bulkdata saved for tag ${tag}: ${metadataItem[tag].BulkDataURI}`,
        );
      } catch (err) {
        console.warn(
          `⚠️  Failed to download bulkdata for tag ${tag} in ${metadataItem["00080018"]?.Value?.[0]}: ${err.message}`,
        );
      }
    }
  }
}

export async function downloadInstance({
  dicomwebUrl,
  options,
  seriesInstanceUID,
  sopInstanceUID,
  seriesMetadata,
  downloadDir,
  dicomWebConfig,
}) {
  const seriesDir = `${downloadDir}/series/${seriesInstanceUID}`;
  const instanceDir = `${seriesDir}/instances/${sopInstanceUID}`;
  const framesDir = `${instanceDir}/frames`;
  const bulkdataPath = `${downloadDir}/bulkdata`;

  fs.mkdirSync(instanceDir, { recursive: true });
  fs.mkdirSync(framesDir, { recursive: true });

  const metadataItem = seriesMetadata.find(
    (i) => i["00080018"]?.Value?.[0] === sopInstanceUID,
  );
  const numberOfFrames = metadataItem?.["00280008"]?.Value?.[0] || 1;

  console.log(
    `🧮 ${numberOfFrames} frame(s) to download for instance ${sopInstanceUID}`,
  );

  for (let frameNumber = 1; frameNumber <= numberOfFrames; frameNumber++) {
    const frameUrl = `${dicomwebUrl}/studies/${options.study}/series/${seriesInstanceUID}/instances/${sopInstanceUID}/frames/${frameNumber}`;
    const frameData = await dicomweb.readDicomWeb(frameUrl, options);
    if (frameData?.error || frameData?.statusCode === 403) {
      console.warn(`⚠️  Skipping frame ${frameNumber} (not available)`);
      break;
    }

    fs.writeFileSync(
      `${framesDir}/${frameNumber}`,
      frameData.buffer || frameData,
    );
  }

  await downloadBulkData(metadataItem, {
    dicomwebUrl,
    options,
    studyUID: options.study,
    seriesUID: seriesInstanceUID,
    dicomWebConfig,
    bulkdataPath,
  });

  const metaOutPath = `${instanceDir}/metadata/index.json`;
  fs.mkdirSync(`${instanceDir}/metadata`, { recursive: true });
  saveJson(metaOutPath, metadataItem, options.zipJson);
  console.log(`✅ Saved instance ${sopInstanceUID}\n`);
}

export async function downloadSeries(
  dicomwebUrl,
  options,
  series,
  downloadDir,
  dicomWebConfig,
) {
  const nonFrameSOPs = {
    "1.2.840.10008.5.1.4.1.1.88.11": "Basic Text SR",
    "1.2.840.10008.5.1.4.1.1.88.22": "Enhanced SR",
    "1.2.840.10008.5.1.4.1.1.88.33": "Comprehensive SR",
    "1.2.840.10008.5.1.4.1.1.481.3": "RT Structure Set",
    "1.2.840.10008.5.1.4.1.1.104.1": "Encapsulated PDF",
  };

  const seriesInstanceUID = series["0020000E"]?.Value?.[0];
  if (!seriesInstanceUID) return;

  const seriesDir = `${downloadDir}/series/${seriesInstanceUID}`;
  const instancesPath = `${seriesDir}/instances`;
  const metadataUrl = `${dicomwebUrl}/studies/${options.study}/series/${seriesInstanceUID}/metadata`;
  const seriesMetadata = await dicomweb.readDicomWeb(metadataUrl, options);
  const metadataMap = Object.fromEntries(
    seriesMetadata.map((item) => [
      item["00080018"]?.Value?.[0],
      item["00080016"]?.Value?.[0],
    ]),
  );

  const instancesUrl = `${dicomwebUrl}/studies/${options.study}/series/${seriesInstanceUID}/instances`;
  const instancesList = await dicomweb.readDicomWeb(instancesUrl, options);

  let savedAnyInstance = false;
  for (const instance of instancesList) {
    const sopInstanceUID = instance["00080018"]?.Value?.[0];
    const sopClassUID = metadataMap[sopInstanceUID];
    if (!sopInstanceUID || !sopClassUID) continue;

    if (nonFrameSOPs[sopClassUID]) {
      console.warn(
        `⚠️  Skipping ${nonFrameSOPs[sopClassUID]} instance (${sopClassUID}): ${sopInstanceUID}`,
      );
      continue;
    }

    if (!savedAnyInstance) {
      console.log(`📦 Downloading series ${seriesInstanceUID}`);
      fs.mkdirSync(seriesDir, { recursive: true });
      fs.mkdirSync(instancesPath, { recursive: true });
      saveJson(`${seriesDir}/metadata`, seriesMetadata, options.zipJson);
      savedAnyInstance = true;
    }

    await downloadInstance({
      dicomwebUrl,
      options,
      seriesInstanceUID,
      sopInstanceUID,
      seriesMetadata,
      downloadDir,
      dicomWebConfig,
    });
  }

  if (!savedAnyInstance) {
    console.log(
      `🚫 Skipped series ${seriesInstanceUID} (no valid instances saved)\n`,
    );
  }
}

export async function downloadSeriesList(dicomwebUrl, options, downloadDir) {
  console.log("🔍 Fetching series list...");
  const url = `${dicomwebUrl}/studies/${options.study}/series`;
  const seriesList = await dicomweb.readDicomWeb(url, options);
  if (!seriesList || seriesList.length === 0) {
    console.error("No series found for the study.");
    process.exit(0);
  }
  const seriesPath = `${downloadDir}/series`;
  fs.mkdirSync(seriesPath, { recursive: true });
  saveJson(`${seriesPath}/index.json`, seriesList, options.zipJson);
  console.log("📄 Saved series list\n");
  return seriesList;
}

export async function downloadStudyMetadata(dicomwebUrl, options, downloadDir) {
  console.log("\n🔍 Fetching study metadata...");
  const url = `${dicomwebUrl}/studies/${options.study}`;
  const metadata = await dicomweb.readDicomWeb(url, options);
  const outPath = `${downloadDir}/index.json`;
  saveJson(outPath, metadata, options.zipJson);
  console.log("📄 Saved study metadata\n");
  return metadata;
}
