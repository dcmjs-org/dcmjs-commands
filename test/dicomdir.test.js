// test/dicomdir.test.js
//
// dcmjs dicomdir: walk a tree, extract record keys with a partial parse,
// build a real DICOMDIR via dcmjs.media, and read it back. Fixtures are
// derived from test/fixtures/sample-dicom.dcm with rewritten UIDs so the
// tree spans two series.

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { runDicomdir } from "../src/commands/dicomdir.js";

const require = createRequire(import.meta.url);
const dcmjs = require("dcmjs");
dcmjs.log.setLevel("silent");

const { DicomMessage, DicomMetaDictionary } = dcmjs.data;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "sample-dicom.dcm");

let dir;

/** Write a copy of the fixture with rewritten identity tags. */
function writeInstance(filePath, { sopUid, seriesUid, instanceNumber }) {
  const buffer = fs.readFileSync(FIXTURE);
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
  const dicomDict = DicomMessage.readFile(arrayBuffer);
  dicomDict.upsertTag("00080018", "UI", [sopUid]);
  dicomDict.upsertTag("0020000E", "UI", [seriesUid]);
  dicomDict.upsertTag("00200013", "IS", [String(instanceNumber)]);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(dicomDict.write()));
}

function capture() {
  const lines = [];
  return { write: (text) => lines.push(text), lines };
}

async function dicomdir(positionals, values = {}) {
  const out = capture();
  const err = capture();
  const code = await runDicomdir({
    dcmjs,
    positionals,
    values,
    stdout: out.write,
    stderr: err.write,
  });
  return { code, out: out.lines, err: err.lines };
}

function readDicomDir(filePath) {
  const buffer = fs.readFileSync(filePath);
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
  const dicomDict = DicomMessage.readFile(arrayBuffer);
  return {
    meta: DicomMetaDictionary.naturalizeDataset(dicomDict.meta),
    dataset: DicomMetaDictionary.naturalizeDataset(dicomDict.dict),
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dicomdir-"));
  // ISO 9660 conformant names, two series
  writeInstance(path.join(dir, "source", "S1", "IM000001"), {
    sopUid: "2.25.101",
    seriesUid: "2.25.11",
    instanceNumber: 1,
  });
  writeInstance(path.join(dir, "source", "S1", "IM000002"), {
    sopUid: "2.25.102",
    seriesUid: "2.25.11",
    instanceNumber: 2,
  });
  writeInstance(path.join(dir, "source", "S2", "IM000001"), {
    sopUid: "2.25.201",
    seriesUid: "2.25.22",
    instanceNumber: 1,
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("builds a DICOMDIR indexing the tree in place", async () => {
  const source = path.join(dir, "source");
  const { code, out } = await dicomdir([source]);
  expect(code).toBe(0);
  expect(out.join("\n")).toMatch(/3 instances, 2 series, 1 study, 1 patient/);

  const { meta, dataset } = readDicomDir(path.join(source, "DICOMDIR"));
  expect(meta.MediaStorageSOPClassUID).toBe("1.2.840.10008.1.3.10");

  const records = dataset.DirectoryRecordSequence;
  const types = records.map((r) => r.DirectoryRecordType);
  expect(types).toEqual([
    "PATIENT",
    "STUDY",
    "SERIES",
    "IMAGE",
    "IMAGE",
    "SERIES",
    "IMAGE",
  ]);
  const firstImage = records.find((r) => r.DirectoryRecordType === "IMAGE");
  expect(firstImage.ReferencedFileID).toEqual(["S1", "IM000001"]);
  expect(firstImage.ReferencedSOPInstanceUIDInFile).toBe("2.25.101");
});

test("non-conformant names warn by default and fail with --strict", async () => {
  const source = path.join(dir, "source");
  writeInstance(path.join(source, "series-x", "img001.dcm"), {
    sopUid: "2.25.301",
    seriesUid: "2.25.33",
    instanceNumber: 1,
  });

  const warned = await dicomdir([source]);
  expect(warned.code).toBe(0);
  expect(warned.err.join("\n")).toMatch(/not ISO 9660 level 1 conformant/);
  expect(warned.err.join("\n")).toMatch(/use --copy/);

  const strict = await dicomdir([source], { strict: true });
  expect(strict.code).toBe(1);
});

test("--copy stages DICOM/IM%06d and writes a conformant DICOMDIR", async () => {
  const source = path.join(dir, "source");
  const dest = path.join(dir, "cd");
  const { code } = await dicomdir([source], { copy: dest });
  expect(code).toBe(0);

  const staged = fs.readdirSync(path.join(dest, "DICOM")).sort();
  expect(staged).toEqual(["IM000001", "IM000002", "IM000003"]);

  const { dataset } = readDicomDir(path.join(dest, "DICOMDIR"));
  const images = dataset.DirectoryRecordSequence.filter(
    (r) => r.DirectoryRecordType === "IMAGE"
  );
  expect(images.map((r) => r.ReferencedFileID)).toEqual([
    ["DICOM", "IM000001"],
    ["DICOM", "IM000002"],
    ["DICOM", "IM000003"],
  ]);
});

test("--copy refuses a non-empty destination", async () => {
  const dest = path.join(dir, "cd");
  fs.mkdirSync(path.join(dest, "DICOM"), { recursive: true });
  fs.writeFileSync(path.join(dest, "DICOM", "EXISTING"), "x");
  const { code, err } = await dicomdir([path.join(dir, "source")], {
    copy: dest,
  });
  expect(code).toBe(1);
  expect(err.join("\n")).toMatch(/refusing to merge/);
});

test("--json is a dry run with the full record payload", async () => {
  const source = path.join(dir, "source");
  const { code, out } = await dicomdir([source], { json: true });
  expect(code).toBe(0);
  expect(fs.existsSync(path.join(source, "DICOMDIR"))).toBe(false);

  const payload = JSON.parse(out.join(""));
  expect(payload.summary.instances).toBe(3);
  expect(payload.entries).toHaveLength(3);
  expect(payload.entries[0].sourcePath).toBeUndefined();
  expect(payload.warnings).toEqual([]);
  expect(payload.skipped).toEqual([]);
});

test("missing directory argument prints usage", async () => {
  const { code, err } = await dicomdir([]);
  expect(code).toBe(1);
  expect(err.join("\n")).toMatch(/usage: dcmjs dicomdir/);
});

test("empty directory is an error", async () => {
  const empty = path.join(dir, "empty");
  fs.mkdirSync(empty);
  const { code, err } = await dicomdir([empty]);
  expect(code).toBe(1);
  expect(err.join("\n")).toMatch(/no DICOM files found/);
});

describe("output location and resilience (review fixes)", () => {
  let tree;
  beforeEach(() => {
    tree = fs.mkdtempSync(path.join(os.tmpdir(), "dcmjs-dicomdir-fix-"));
    writeInstance(path.join(tree, "DICOM", "IM000001"), {
      sopUid: "2.25.501",
      seriesUid: "2.25.50",
      instanceNumber: 1,
    });
    writeInstance(path.join(tree, "DICOM", "IM000002"), {
      sopUid: "2.25.502",
      seriesUid: "2.25.50",
      instanceNumber: 2,
    });
  });
  afterEach(() => {
    fs.rmSync(tree, { recursive: true, force: true });
  });

  test("a second run in place excludes the first run's DICOMDIR", async () => {
    const first = await dicomdir([tree]);
    expect(first.code).toBe(0);
    const second = await dicomdir([tree]);
    expect(second.code).toBe(0);
    expect(second.out.join("\n")).toMatch(/2 instances/);
    expect(second.err.join("\n")).not.toMatch(/DICOMDIR/);
  });

  test("-o outside the tree is refused with a corrective error", async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "dcmjs-elsewhere-"));
    try {
      const { code, err } = await dicomdir([tree], {
        output: path.join(elsewhere, "DICOMDIR"),
      });
      expect(code).toBe(1);
      expect(err.join("\n")).toMatch(/below its own directory.*--copy/s);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("-o above the tree prefixes the file IDs with the path down", async () => {
    const { code } = await dicomdir([path.join(tree, "DICOM")], {
      output: path.join(tree, "DICOMDIR"),
      json: true,
    });
    expect(code).toBe(0);
    const payloadRun = await dicomdir([path.join(tree, "DICOM")], {
      output: path.join(tree, "DICOMDIR"),
      json: true,
    });
    const payload = JSON.parse(payloadRun.out.join("\n"));
    expect(payload.entries[0].referencedFileID).toEqual(["DICOM", "IM000001"]);
  });

  test("a corrupt DICM-magic file is skipped with a warning, not fatal", async () => {
    const bad = Buffer.alloc(200);
    bad.write("DICM", 128, "ascii"); // magic but no parseable content
    fs.writeFileSync(path.join(tree, "DICOM", "BADFILE"), bad);
    const { code, out, err } = await dicomdir([tree]);
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/2 instances/);
    expect(err.join("\n")).toMatch(/skipping.*BADFILE.*unreadable as DICOM/s);
  });

  test("--json reports parse-failure skips alongside missing-UID skips", async () => {
    const bad = Buffer.alloc(200);
    bad.write("DICM", 128, "ascii");
    fs.writeFileSync(path.join(tree, "DICOM", "BADFILE"), bad);
    const { code, out } = await dicomdir([tree], { json: true });
    expect(code).toBe(0);
    const payload = JSON.parse(out.join("\n"));
    expect(payload.skipped).toHaveLength(1);
    expect(payload.skipped[0].file).toMatch(/BADFILE/);
    expect(payload.skipped[0].error).toBeTruthy();
  });
});
