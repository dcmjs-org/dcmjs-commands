#!/usr/bin/env node
// bin/dcmjs.js
//
// Entry point for the dcmjs bin. Loads the built dcmjs bundle via
// createRequire (the dcmjs dependency's main is build/dcmjs.js) and hands
// it to the router. Tests bypass this file and inject dcmjs directly.

import { createRequire } from "node:module";
import { runCli } from "../src/cli.js";
import { exitOnEpipe } from "../src/utils/exitOnEpipe.js";

const require = createRequire(import.meta.url);

// `dcmjs dump file | head` must end quietly when head closes the pipe
exitOnEpipe();

let dcmjs;
try {
  dcmjs = require("dcmjs");
} catch {
  console.error(
    "dcmjs CLI needs the built dcmjs bundle.\n" +
      "If dcmjs is installed via file:../dcmjs, run `pnpm install && pnpm run build` in that checkout first."
  );
  process.exit(1);
}

// Parser chatter would drown command output
dcmjs.log.setLevel("silent");
dcmjs.log.getLogger("validation.dcmjs").setLevel("silent");

runCli({
  dcmjs,
  argv: process.argv.slice(2),
  stdout: (text) => process.stdout.write(text + "\n"),
  stderr: (text) => process.stderr.write(text + "\n"),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`dcmjs: ${err.message}`);
    process.exitCode = 1;
  }
);
