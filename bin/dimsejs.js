#!/usr/bin/env node
// bin/dimsejs.js
//
// DIMSE SCU tools: echo, find, store, get (src/commands/dimse.js).

import { createRequire } from "node:module";
import { Command } from "commander";
import { registerDimseCommands } from "../src/commands/dimse.js";
import { exitOnEpipe } from "../src/utils/exitOnEpipe.js";

exitOnEpipe();

const { version } = createRequire(import.meta.url)("../package.json");
const program = new Command();

program
  .name("dimsejs")
  .description(
    "DIMSE networking tools: C-ECHO, C-FIND, C-STORE and C-GET as an SCU"
  )
  .version(version);

registerDimseCommands(program, {
  stdout: (text) => console.log(text),
  stderr: (text) => console.error(text),
  exit: (code) => {
    process.exitCode = code;
  },
});

program.parseAsync().catch((err) => {
  console.error(`dimsejs: ${err.message}`);
  process.exitCode = 1;
});
