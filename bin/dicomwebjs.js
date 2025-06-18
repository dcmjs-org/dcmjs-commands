#!/usr/bin/env bun
import { Command } from "commander";
import { dicomweb, instanceDicom, dumpDicom } from "../src/index.js";
import cliDownload from "./cliDownload.js";
import cliPart10 from "./cliPart10.js";

const program = new Command();

program.option(
  "-s, --study <studyInstanceUID>",
  "Download a specific study instance UID"
);

program
  .name("dicomwebjs")
  .description("dicomwebjs based tools for manipulation of DICOMweb")
  .version("0.0.1")
  .option("--seriesUID <seriesUID>", "For a specific seriesUID");

program
  .command("dump")
  .description("Dump a dicomweb file")
  .argument("<dicomwebUrl>", "dicomweb URL or file location")
  .option("--debug", "Set debug level logging")
  .action(async (fileName, options) => {
    const qido = await dicomweb.readDicomWeb(fileName, options);
    for (const dict of qido) {
      dumpDicom({ dict });
    }
  });

program
  .command("instance")
  .description("Write the instance data")
  .argument("<part10>", "part 10 file")
  .option("-p, --pretty", "Pretty print")
  .option("--debug", "Set debug level logging")
  .action(async (fileName, options) => {
    const qido = await dicomweb.readDicomWeb(fileName, options);
    for (const dict of qido) {
      instanceDicom({ dict }, options);
    }
  });

cliDownload(program);
cliPart10(program);

program.parse();
