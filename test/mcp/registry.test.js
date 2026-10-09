// test/mcp/registry.test.js
//
// The MCP tool handlers, called directly with the real dcmjs bundle — no
// server, no transport. Asserts the structured result shapes, warning
// propagation, and that error messages are corrective (they name the
// parameter to change).

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { TOOLS } from "../../src/mcp/registry.js";

const require = createRequire(import.meta.url);
const dcmjs = require("dcmjs");
dcmjs.log.setLevel("silent");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "..", "fixtures", "sample-dicom.dcm");

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function call(name, args) {
  return TOOLS[name].handler({ dcmjs, args });
}

test("every tool has the registry contract fields", () => {
  for (const [name, spec] of Object.entries(TOOLS)) {
    expect(typeof spec.title).toBe("string");
    expect(spec.description.length).toBeGreaterThan(80); // real guidance, not a label
    expect(spec.inputSchema).toBeDefined();
    expect(typeof spec.handler).toBe("function");
    expect(name).toMatch(/^[a-z_]+$/);
  }
});

test("dicom_dump json returns the naturalized dataset", async () => {
  const result = await call("dicom_dump", { file: FIXTURE });
  expect(result.ok).toBe(true);
  expect(result.dataset.SOPInstanceUID).toBeDefined();
  expect(result.dataset.Modality).toBeDefined();
});

test("dicom_dump lines returns element lines", async () => {
  const result = await call("dicom_dump", { file: FIXTURE, format: "lines" });
  expect(result.lines.join("\n")).toMatch(/\(0008,0060\)/);
});

test("dicom_instance returns tag-keyed DICOM JSON", async () => {
  const result = await call("dicom_instance", { file: FIXTURE });
  expect(result.instance["00080060"].vr).toBe("CS");
});

test("dicom_validate reports failures per file", async () => {
  fs.copyFileSync(FIXTURE, path.join(dir, "a.dcm"));
  // .dcm extension but not DICOM: discovered via extension fallback,
  // fails parse — must appear as a failure record, not vanish
  fs.writeFileSync(path.join(dir, "junk.dcm"), "not dicom at all");
  const result = await call("dicom_validate", { path: dir });
  expect(result.total).toBe(2);
  expect(result.failures).toBe(1);
  expect(result.ok).toBe(false);
  const failed = result.records.find((r) => r.status === "fail");
  expect(failed.file).toMatch(/junk\.dcm$/);
  expect(failed.error).toBeTruthy();
});

test("dicom_convert binary target without output is a corrective error", async () => {
  await expect(
    call("dicom_convert", { input: FIXTURE, to: "dcm" })
  ).rejects.toThrow(/pass output: <path>/);
});

test("dicom_convert dcm → json returns the dataset inline", async () => {
  const result = await call("dicom_convert", { input: FIXTURE, to: "json" });
  expect(result.ok).toBe(true);
  expect(result.result.SOPInstanceUID).toBeDefined();
});

test("dicom_convert dcm → dcm writes and reports the path", async () => {
  const output = path.join(dir, "copy.dcm");
  const result = await call("dicom_convert", {
    input: FIXTURE,
    to: "dcm",
    output,
  });
  expect(result.written).toBe(output);
  expect(fs.existsSync(output)).toBe(true);
});

test("dicom_anonymize dry_run returns the change list, writes nothing", async () => {
  const input = path.join(dir, "a.dcm");
  fs.copyFileSync(FIXTURE, input);
  const result = await call("dicom_anonymize", { file: input, dry_run: true });
  expect(result.ok).toBe(true);
  expect(Array.isArray(result.changes)).toBe(true);
  expect(result.changes.length).toBeGreaterThan(0);
  for (const change of result.changes) {
    expect(change.tag).toMatch(/^[0-9A-F]{8}$/i);
    expect(["removed", "emptied", "replaced"]).toContain(change.action);
  }
  expect(fs.readdirSync(dir)).toEqual(["a.dcm"]); // nothing written
});

test("dicom_anonymize writes a scrubbed copy", async () => {
  const input = path.join(dir, "a.dcm");
  fs.copyFileSync(FIXTURE, input);
  const output = path.join(dir, "anon.dcm");
  const result = await call("dicom_anonymize", { file: input, output });
  expect(result.written).toBe(output);
  expect(fs.existsSync(output)).toBe(true);
});

test("dicom_filter sets tags and reports byte count", async () => {
  const output = path.join(dir, "filtered.dcm");
  const result = await call("dicom_filter", {
    input: FIXTURE,
    output,
    set: [{ tag: "00100010", value: "FOX^JANE" }],
    drop: ["00104000"],
  });
  expect(result.written).toBe(output);
  expect(result.bytesWritten).toBeGreaterThan(0);
  expect(result.filters).toBe(2);

  const check = await call("dicom_dump", { file: output });
  // PN values serialize as { Alphabetic } objects in the JSON dataset
  expect(JSON.stringify(check.dataset.PatientName)).toContain("FOX^JANE");
});

test("dicomdir_create dry_run returns the record payload", async () => {
  fs.mkdirSync(path.join(dir, "tree"));
  fs.copyFileSync(FIXTURE, path.join(dir, "tree", "IM000001"));
  const result = await call("dicomdir_create", {
    directory: path.join(dir, "tree"),
    dry_run: true,
  });
  expect(result.summary.instances).toBe(1);
  expect(result.entries).toHaveLength(1);
  expect(fs.existsSync(path.join(dir, "tree", "DICOMDIR"))).toBe(false);
});

test("dicomdir_create writes a DICOMDIR and returns { written }", async () => {
  fs.mkdirSync(path.join(dir, "tree"));
  fs.copyFileSync(FIXTURE, path.join(dir, "tree", "IM000001"));
  const result = await call("dicomdir_create", {
    directory: path.join(dir, "tree"),
  });
  expect(result.written).toBe(path.join(dir, "tree", "DICOMDIR"));
  expect(fs.existsSync(result.written)).toBe(true);

  const check = await call("dicom_dump", { file: result.written });
  expect(check.dataset.DirectoryRecordSequence).toBeDefined();
});

test("underlying command errors surface with their corrective text", async () => {
  await expect(
    call("dicom_dump", { file: path.join(dir, "nope.dcm") })
  ).rejects.toThrow(/nope\.dcm/);
});

test("dicom_convert accepts the mp4 target and forwards fragment_bytes", async () => {
  const { makeTinyMp4 } = await import("../utils/makeTinyMp4.js");
  const mp4Path = path.join(dir, "movie.mp4");
  fs.writeFileSync(mp4Path, makeTinyMp4());

  // binary guard covers mp4
  await expect(
    call("dicom_convert", { input: mp4Path, to: "dcm" })
  ).rejects.toThrow(/pass output: <path>/);

  const dcmPath = path.join(dir, "movie.dcm");
  const result = await call("dicom_convert", {
    input: mp4Path,
    to: "dcm",
    output: dcmPath,
    fragment_bytes: 512,
    patient_name: "DOE^JANE",
  });
  expect(result.written).toBe(dcmPath);
  const expected = Math.ceil(fs.statSync(mp4Path).size / 512);
  expect(result.warnings.join("\n")).toContain(`${expected} fragments`);

  const recovered = path.join(dir, "recovered.mp4");
  const back = await call("dicom_convert", {
    input: dcmPath,
    to: "mp4",
    output: recovered,
  });
  expect(back.written).toBe(recovered);
  expect(
    Buffer.compare(fs.readFileSync(recovered), fs.readFileSync(mp4Path))
  ).toBe(0);
});
