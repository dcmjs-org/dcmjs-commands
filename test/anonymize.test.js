// test/anonymize.test.js

import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const dcmjs = require("dcmjs");
dcmjs.log.setLevel("silent");
dcmjs.log.getLogger("validation.dcmjs").setLevel("silent");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { runAnonymize } from "../src/commands/anonymize.js";
import { readFileArrayBuffer } from "../src/io.js";

const FIXTURE = path.join(__dirname, "fixtures", "sample-dicom.dcm");

const { DicomMessage, DicomMetaDictionary } = dcmjs.data;

function capture() {
  const lines = [];
  return { lines, write: (text) => lines.push(text) };
}

let tmpDir;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcmjs-cli-anon-"));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("anonymize writes a scrubbed copy", async () => {
  const out = capture();
  const err = capture();
  const outputPath = path.join(tmpDir, "anon.dcm");
  const code = await runAnonymize({
    dcmjs,
    positionals: [FIXTURE],
    values: { output: outputPath },
    stdout: out.write,
    stderr: err.write,
  });

  expect(code).toBe(0);
  const dataset = DicomMetaDictionary.naturalizeDataset(
    DicomMessage.readFile(readFileArrayBuffer(outputPath)).dict
  );
  const name = Array.isArray(dataset.PatientName)
    ? dataset.PatientName[0]
    : dataset.PatientName;
  expect(name.Alphabetic || name).toBe("ANON^PATIENT");
});

test("anonymize defaults output to <basename>-anon.dcm beside the input", async () => {
  const out = capture();
  const err = capture();
  const inputCopy = path.join(tmpDir, "source.dcm");
  fs.copyFileSync(FIXTURE, inputCopy);

  const code = await runAnonymize({
    dcmjs,
    positionals: [inputCopy],
    values: {},
    stdout: out.write,
    stderr: err.write,
  });

  expect(code).toBe(0);
  expect(fs.existsSync(path.join(tmpDir, "source-anon.dcm"))).toBe(true);
});

test("anonymize refuses to overwrite its input", async () => {
  const out = capture();
  const err = capture();
  const inputCopy = path.join(tmpDir, "inplace.dcm");
  fs.copyFileSync(FIXTURE, inputCopy);

  const code = await runAnonymize({
    dcmjs,
    positionals: [inputCopy],
    values: { output: inputCopy },
    stdout: out.write,
    stderr: err.write,
  });

  expect(code).toBe(1);
  expect(err.lines.join("\n")).toMatch(/overwrite/i);
});
