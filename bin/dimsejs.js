#!/usr/bin/env node
// bin/dimsejs.js
//
// DIMSE networking tools — EXPERIMENTAL STUB. The original `study`
// command pretended to query an AE but actually parsed a local file.
// Real C-FIND/C-MOVE support (via dcmjs-dimse) is future work; until
// then this bin says so honestly and exits 2.

import { Command } from "commander";

const program = new Command();

program
  .name("dimsejs")
  .description(
    "dimse based DICOM networking tools (experimental — not implemented)"
  )
  .version("0.1.0");

program
  .command("study")
  .description("Query an AE for studies (not implemented)")
  .argument("<aeName>", "AE to query")
  .action(() => {
    console.error(
      "dimsejs study: experimental — not implemented (DIMSE support is a stub)"
    );
    process.exitCode = 2;
  });

program.parse();
