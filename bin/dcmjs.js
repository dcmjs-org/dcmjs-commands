#!/usr/bin/env node
import { Command } from "commander";
import {
  readDicom,
  instanceDicom,
  dumpDicom,
  naturalDicom,
} from "../src/index.js";

const program = new Command();

program
  .name("dcmjs")
  .description("dcmjs based tools for manipulation DICOM files")
  .version("0.0.1");

program
  .command("dump")
  .description("Dump a dicom file")
  .argument("<part10>", "part 10 file")
  // .option('-s, --separator <char>', 'separator character', ',')
  .action(async (fileName, _options) => {
    const dicomDict = readDicom(fileName);
    dumpDicom(dicomDict);
  });

program
  .command("natural")
  .description("Show the natural representation of a file")
  .argument("<part10>", "part 10 file")
  // .option('-s, --separator <char>', 'separator character', ',')
  .action(async (fileName, _options) => {
    const dicomDict = readDicom(fileName);
    naturalDicom(dicomDict);
  });

program
  .command("instance")
  .description("Write the instance data")
  .argument("<part10>", "part 10 file")
  .option("-p, --pretty", "Pretty print")
  .action(async (fileName, options) => {
    const dicomDict = readDicom(fileName);
    instanceDicom(dicomDict, options);
  });

program.parse();
