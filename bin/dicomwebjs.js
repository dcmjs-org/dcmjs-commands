#!/usr/bin/env node
// bin/dicomwebjs.js
//
// DICOMweb tools: dump/instance against http or Static DICOMweb file
// sources, plus download/part10 study transfers (src/commands/webTransfer).

import { Command } from "commander";
import { dicomweb, instanceDicom, dumpDicom } from "../src/index.js";
import { registerTransferCommands } from "../src/commands/webTransfer.js";
import { setOptions } from "../src/utils/logger.js";
import { exitOnEpipe } from "../src/utils/exitOnEpipe.js";

// `dicomwebjs dump url | head` must end quietly when head closes the pipe
exitOnEpipe();

const program = new Command();

program
  .name("dicomwebjs")
  .description("dicomwebjs based tools for manipulation of DICOMweb")
  .version("0.1.0");

program
  .command("dump")
  .description("Dump a dicomweb query/metadata response")
  .argument("<dicomwebUrl>", "dicomweb URL or file location")
  .option("--debug", "debug logging")
  .option("--verbose", "info-level logging")
  .option("--quiet", "errors only")
  .action(async (fileName, options) => {
    setOptions(options);
    const qido = await dicomweb.readDicomWeb(fileName, options);
    for (const dict of qido) {
      dumpDicom({ dict });
    }
  });

program
  .command("instance")
  .description("Write the instance data as DICOM JSON")
  .argument("<dicomwebUrl>", "dicomweb URL or file location")
  .option("-p, --pretty", "pretty print")
  .option("--debug", "debug logging")
  .option("--verbose", "info-level logging")
  .option("--quiet", "errors only")
  .action(async (fileName, options) => {
    setOptions(options);
    const qido = await dicomweb.readDicomWeb(fileName, options);
    for (const dict of qido) {
      instanceDicom({ dict }, options);
    }
  });

registerTransferCommands(program);

program.parseAsync().catch((err) => {
  console.error(`dicomwebjs: ${err.message}`);
  process.exitCode = 1;
});
