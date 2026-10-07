// test/cli.test.js — router + argv parsing

import path from "path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const dcmjs = require("dcmjs");
dcmjs.log.setLevel("silent");
dcmjs.log.getLogger("validation.dcmjs").setLevel("silent");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { runCli } from "../src/cli.js";

const FIXTURE = path.join(__dirname, "fixtures", "sample-dicom.dcm");

function capture() {
  const lines = [];
  return { lines, write: (text) => lines.push(text) };
}

async function cli(argv) {
  const out = capture();
  const err = capture();
  const code = await runCli({
    dcmjs,
    argv,
    stdout: out.write,
    stderr: err.write,
  });
  return { code, out: out.lines.join("\n"), err: err.lines.join("\n") };
}

test("--help prints usage and exits 0", async () => {
  const { code, out } = await cli(["--help"]);
  expect(code).toBe(0);
  expect(out).toMatch(/convert/);
  expect(out).toMatch(/dump/);
  expect(out).toMatch(/anonymize/);
  expect(out).toMatch(/validate/);
});

test("no arguments prints usage and exits 1", async () => {
  const { code, err } = await cli([]);
  expect(code).toBe(1);
  expect(err).toMatch(/usage/i);
});

test("unknown command exits 1", async () => {
  const { code, err } = await cli(["frobnicate"]);
  expect(code).toBe(1);
  expect(err).toMatch(/unknown command/i);
});

test("unknown option exits 1 with the parseArgs message", async () => {
  const { code, err } = await cli(["dump", FIXTURE, "--bogus"]);
  expect(code).toBe(1);
  expect(err).toMatch(/bogus/);
});

test("full argv path: convert --to json", async () => {
  const { code, out } = await cli(["convert", FIXTURE, "--to", "json"]);
  expect(code).toBe(0);
  expect(JSON.parse(out).Modality).toBe("MR");
});
