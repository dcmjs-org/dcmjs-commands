#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { Command } from "commander"
import { dicomweb, instanceDicom, dumpDicom, utils } from "../src/index.js"

const program = new Command()

program.option(
  "-s, --study <studyInstanceUID>",
  "Download a specific study instance UID"
)

program
  .name("dicomwebjs")
  .description("dicomwebjs based tools for manipulation of DICOMweb")
  .version("0.0.1")
  .option("--seriesUID <seriesUID>", "For a specific seriesUID")

program
  .command("dump")
  .description("Dump a dicomweb file")
  .argument("<dicomwebUrl>", "dicomweb URL or file location")
  .option("--debug", "Set debug level logging")
  .action(async (fileName, options) => {
    const qido = await dicomweb.readDicomWeb(fileName, options)
    for (const dict of qido) {
      dumpDicom({ dict })
    }
  })

program
  .command("download")
  .description("Download dicomweb file(s)")
  .argument("<dicomwebUrl>", "dicomweb URL to the base DICOMweb service")
  .option(
    "-d, --directory <dicomwebdir>",
    "Download to local DICOMweb directory"
  )
  .option("--debug", "Set debug level logging")
  .action(async (fileName, options) => {
    utils.logger.setOptions(options)
    let downloadUrls = [fileName]
    if (options.study) {
      downloadUrls = await dicomweb.queryDownloads(fileName, options)
    }
    for (const downloadUrl of downloadUrls) {
      const data = await dicomweb.readDicomWeb(downloadUrl, options)
      dicomweb.store(downloadUrl, data, options)
    }
  })

program
  .command("download-v2")
  .description("Download a full DICOM study from a DICOMweb service")
  .argument("<dicomwebUrl>", "DICOMweb base URL")
  .option("-S, --study <studyInstanceUID>", "Download a specific study instance UID")
  .option("-d, --directory <dicomwebdir>", "Download to local directory", "./")
  .option("--debug", "Enable debug logging")
  .action(async (dicomwebUrl, options) => {
    utils.logger.setOptions(options);
  
    if (!options.study) {
      console.error("Error: You must provide a StudyInstanceUID with --study");
      process.exit(1);
    }
  
    const baseDir = path.join(options.directory, options.study);
    let downloadDir = baseDir;
    let counter = 1;

    while (fs.existsSync(downloadDir)) {
      downloadDir = `${baseDir}_${counter}`;
      counter++;
    }

    fs.mkdirSync(downloadDir, { recursive: true });

    console.log(`📁 Study will be downloaded to: ${downloadDir}`);
  
    const dicomWebConfig = {
      wadoRoot: dicomwebUrl,
      bulkDataURI: {
        relativeResolution: "studies",
      },
    };
  
    await utils.service.downloadStudyMetadata(dicomwebUrl, options, downloadDir);
    const seriesList = await utils.service.downloadSeriesList(dicomwebUrl, options, downloadDir);
  
    for (const series of seriesList) {
      await utils.service.downloadSeries(dicomwebUrl, options, series, downloadDir, dicomWebConfig);
    }
  
    console.log(`🎉 Download complete. All accessible instances and metadata were saved.`);
    console.log(`📁 Study available at: ${downloadDir}`);
    console.log("💡 Some files may have been skipped due to server restrictions or unsupported SOP Classes.");
  
    process.exit(0);
  });

program
  .command("instance")
  .description("Write the instance data")
  .argument("<part10>", "part 10 file")
  .option("-p, --pretty", "Pretty print")
  .option("--debug", "Set debug level logging")
  .action(async (fileName, options) => {
    const qido = await dicomweb.readDicomWeb(fileName, options)
    for (const dict of qido) {
      instanceDicom({ dict }, options)
    }
  })

program.parse()
