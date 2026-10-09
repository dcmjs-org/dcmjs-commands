// test/convert.test.js

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
import { runConvert } from "../src/commands/convert.js";
import { readFileArrayBuffer } from "../src/io.js";

const FIXTURE = path.join(__dirname, "fixtures", "sample-dicom.dcm");

const { DicomMessage, DicomMetaDictionary } = dcmjs.data;

const PDF_STRING =
  "%PDF-1.4\n" +
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
  "trailer<</Size 2/Root 1 0 R>>\n" +
  "%%EOF";

function capture() {
  const lines = [];
  return { lines, write: (text) => lines.push(text) };
}

async function convert(positionals, values) {
  const out = capture();
  const err = capture();
  const code = await runConvert({
    dcmjs,
    positionals,
    values,
    stdout: out.write,
    stderr: err.write,
  });
  return { code, out: out.lines.join("\n"), err: err.lines.join("\n") };
}

let tmpDir;
let pdfPath;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcmjs-cli-convert-"));
  pdfPath = path.join(tmpDir, "report.pdf");
  fs.writeFileSync(pdfPath, PDF_STRING);
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("dcm → json (naturalized)", async () => {
  const { code, out } = await convert([FIXTURE], { to: "json" });
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed.Modality).toBe("MR");
  expect(out).toContain("Fall 3");
});

test("dcm → dicomweb-json (DICOM JSON model)", async () => {
  const { code, out } = await convert([FIXTURE], { to: "dicomweb-json" });
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  // Tag-keyed { vr, Value } shape
  expect(parsed["00100010"].vr).toBe("PN");
});

test("dcm → fhir yields an ImagingStudy", async () => {
  const { code, out } = await convert([FIXTURE], {
    to: "fhir",
    pretty: true,
  });
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed.imagingStudy.resourceType).toBe("ImagingStudy");
  expect(parsed.documentReference).toBeNull();
});

test("dcm → fhir --bundle yields a collection Bundle", async () => {
  const { code, out } = await convert([FIXTURE], {
    to: "fhir",
    bundle: true,
  });
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed.resourceType).toBe("Bundle");
  expect(parsed.type).toBe("collection");
});

test("pdf → dcm wraps into an Encapsulated PDF instance", async () => {
  const outputPath = path.join(tmpDir, "wrapped.dcm");
  const { code } = await convert([pdfPath], {
    to: "dcm",
    output: outputPath,
    "patient-name": "Doe^Jane",
    title: "Discharge Summary",
  });
  expect(code).toBe(0);

  const dataset = DicomMetaDictionary.naturalizeDataset(
    DicomMessage.readFile(readFileArrayBuffer(outputPath)).dict
  );
  expect(dataset.SOPClassUID).toBe("1.2.840.10008.5.1.4.1.1.104.1");
  expect(dataset.Modality).toBe("DOC");
  expect(dataset.MIMETypeOfEncapsulatedDocument).toBe("application/pdf");
});

test("dcm → pdf extracts the original bytes (PACS round trip)", async () => {
  const wrappedPath = path.join(tmpDir, "roundtrip.dcm");
  await convert([pdfPath], { to: "dcm", output: wrappedPath });

  const extractedPath = path.join(tmpDir, "extracted.pdf");
  const { code } = await convert([wrappedPath], {
    to: "pdf",
    output: extractedPath,
  });
  expect(code).toBe(0);
  expect(fs.readFileSync(extractedPath, "latin1")).toBe(PDF_STRING);
});

test("pdf → fhir yields a DocumentReference", async () => {
  const { code, out } = await convert([pdfPath], {
    to: "fhir",
    title: "Discharge Summary",
  });
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed.documentReference.resourceType).toBe("DocumentReference");
  expect(parsed.imagingStudy).toBeNull();
});

test("dcm(image) → pdf fails with a clear error", async () => {
  const { code, err } = await convert([FIXTURE], {
    to: "pdf",
    output: path.join(tmpDir, "nope.pdf"),
  });
  expect(code).toBe(1);
  expect(err).toMatch(/[Ee]ncapsulated/);
});

test("pdf → json is rejected as unsupported", async () => {
  const { code, err } = await convert([pdfPath], { to: "json" });
  expect(code).toBe(1);
  expect(err).toMatch(/unsupported/i);
});

test("binary output without -o is refused", async () => {
  const { code, err } = await convert([pdfPath], { to: "dcm" });
  expect(code).toBe(1);
  expect(err).toMatch(/-o/);
});

test("missing --to is an error", async () => {
  const { code, err } = await convert([FIXTURE], {});
  expect(code).toBe(1);
  expect(err).toMatch(/--to/);
});
