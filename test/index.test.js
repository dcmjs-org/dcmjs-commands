// test/index.test.js

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
import { readDicom, dumpDicom } from "../src/index.js";

const FIXTURE = path.join(__dirname, "fixtures", "sample-dicom.dcm");

const PDF_STRING =
  "%PDF-1.4\n" +
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
  "trailer<</Size 2/Root 1 0 R>>\n" +
  "%%EOF";

let tmpDir;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcmjs-commands-index-"));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("readDicom parses a large Part 10 file", () => {
  const dicomDict = readDicom(FIXTURE);
  expect(dicomDict.dict["00080060"].Value[0]).toBe("MR");
});

test("readDicom parses a small (<4KB) file — pooled-Buffer regression", () => {
  // Node pools small reads into a shared Buffer; a bare `.buffer` hands the
  // parser the whole pool instead of the file bytes.
  const { encapsulatePdf } = dcmjs.encapsulated;
  const { datasetToBuffer } = dcmjs.data;
  const dataset = encapsulatePdf(new TextEncoder().encode(PDF_STRING));
  const smallDicom = path.join(tmpDir, "small.dcm");
  fs.writeFileSync(smallDicom, datasetToBuffer(dataset));
  expect(fs.statSync(smallDicom).size).toBeLessThan(4096);

  const dicomDict = readDicom(smallDicom);
  expect(dicomDict.dict["00080016"].Value[0]).toBe(
    "1.2.840.10008.5.1.4.1.1.104.1"
  );
});

test("dumpDicom writes tag lines through an injected stdout", () => {
  const lines = [];
  const dicomDict = readDicom(FIXTURE);
  dumpDicom(dicomDict, { stdout: (...args) => lines.push(args.join(" ")) });
  const text = lines.join("\n");
  expect(text).toContain("00080060");
  expect(text).toContain("Modality");
});
