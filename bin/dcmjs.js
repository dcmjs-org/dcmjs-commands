#!/usr/bin/env node
// bin/dcmjs.js
//
// Entry point for the dcmjs bin. Loads the composite dcmjs surface from
// src/dcmjsBundle.js and hands it to the router. Tests bypass this file
// and inject dcmjs directly.

import { runCli } from "../src/cli.js";
import { exitOnEpipe } from "../src/utils/exitOnEpipe.js";

// `dcmjs dump file | head` must end quietly when head closes the pipe
exitOnEpipe();

let dcmjs;
try {
  ({ default: dcmjs } = await import("../src/dcmjsBundle.js"));
} catch (err) {
  console.error(
    "dcmjs CLI needs the dcmjs bundle.\n" +
      `Run \`npm install\` to fetch the @dcmjs-org packages. (${err.message})`
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
