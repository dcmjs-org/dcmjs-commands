// test/part10Access.test.js
//
// The Part 10 directory source: routing, scan, Static-DICOMweb output via
// the real download flow, part10 round trip, frame extraction, and the
// corrective errors. Fixture trees are copies of sample-dicom.dcm with
// rewritten UIDs (Implicit VR LE, 512x512, 16-bit, one frame, pixel
// length 524288).

import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "node:url";
import { DicomAccess } from "../src/access/DicomAccess.js";
import { runTransfer } from "../src/commands/webTransfer.js";
import { runDicomweb } from "../src/commands/dicomweb.js";
import { extractFrame } from "../src/part10/part10ToDicomWebJson.js";
import {
  looksLikeStaticDicomWeb,
  looksLikePart10Directory,
} from "../src/io.js";

import dcmjs from "../src/dcmjsBundle.js";
dcmjs.log.setLevel("silent");

const { DicomMessage } = dcmjs.data;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "sample-dicom.dcm");

const STUDY_UID = "2.25.777";
const PIXEL_BYTES = 524288;

let dir;

function writeInstance(filePath, { sopUid, seriesUid, instanceNumber }) {
  const buffer = fs.readFileSync(FIXTURE);
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
  const dicomDict = DicomMessage.readFile(arrayBuffer);
  dicomDict.upsertTag("0020000D", "UI", [STUDY_UID]);
  dicomDict.upsertTag("00080018", "UI", [sopUid]);
  dicomDict.upsertTag("0020000E", "UI", [seriesUid]);
  dicomDict.upsertTag("00200013", "IS", [String(instanceNumber)]);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(dicomDict.write()));
}

/** 2 series x 2 instances, extensionless names (CD-style). */
function writeSourceTree(root) {
  writeInstance(path.join(root, "S1", "IM000001"), {
    sopUid: "2.25.101",
    seriesUid: "2.25.11",
    instanceNumber: 1,
  });
  writeInstance(path.join(root, "S1", "IM000002"), {
    sopUid: "2.25.102",
    seriesUid: "2.25.11",
    instanceNumber: 2,
  });
  writeInstance(path.join(root, "S2", "IM000001"), {
    sopUid: "2.25.201",
    seriesUid: "2.25.22",
    instanceNumber: 1,
  });
  writeInstance(path.join(root, "S2", "IM000002"), {
    sopUid: "2.25.202",
    seriesUid: "2.25.22",
    instanceNumber: 2,
  });
}

function gunzipJson(filePath) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(filePath)).toString());
}

function capture() {
  const lines = [];
  return { write: (text) => lines.push(text), lines };
}

async function download(source, dest, studyUID = STUDY_UID) {
  const out = capture();
  const err = capture();
  const code = await runTransfer({
    kind: "download",
    positionals: [source],
    values: { StudyInstanceUID: studyUID, directory: dest },
    stdout: out.write,
    stderr: err.write,
  });
  return { code, out: out.lines, err: err.lines };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "part10src-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("routing", () => {
  test("a directory of Part 10 files routes to Part10DirectoryAccess", async () => {
    const source = path.join(dir, "source");
    writeSourceTree(source);
    expect(looksLikePart10Directory(source)).toBe(true);
    expect(looksLikeStaticDicomWeb(source)).toBe(false);
    const access = await DicomAccess.createInstance(source, {});
    expect(access.constructor.name).toBe("Part10DirectoryAccess");
  });

  test("a studies/ tree routes to StaticDicomWebAccess", async () => {
    const tree = path.join(dir, "tree");
    fs.mkdirSync(path.join(tree, "studies"), { recursive: true });
    expect(looksLikeStaticDicomWeb(tree)).toBe(true);
    const access = await DicomAccess.createInstance(tree, {});
    expect(access.constructor.name).toBe("StaticDicomWebAccess");
  });

  test("isDestination always routes to StaticDicomWebAccess", async () => {
    const source = path.join(dir, "source");
    writeSourceTree(source);
    const access = await DicomAccess.createInstance(source, {
      isDestination: true,
    });
    expect(access.constructor.name).toBe("StaticDicomWebAccess");
  });
});

describe("download from a Part 10 directory", () => {
  test("builds the full Static-DICOMweb tree", async () => {
    const source = path.join(dir, "source");
    const dest = path.join(dir, "web");
    writeSourceTree(source);

    const { code, err } = await download(source, dest);
    expect(err.join("\n")).toBe("");
    expect(code).toBe(0);

    const studyDir = path.join(dest, "studies", STUDY_UID);
    const index = gunzipJson(path.join(studyDir, "index.json.gz"));
    expect(index[0]["0020000D"].Value).toEqual([STUDY_UID]);

    const seriesIndex = gunzipJson(
      path.join(studyDir, "series", "index.json.gz")
    );
    expect(seriesIndex).toHaveLength(2);

    for (const seriesUid of ["2.25.11", "2.25.22"]) {
      const seriesDir = path.join(studyDir, "series", seriesUid);
      const metadata = gunzipJson(path.join(seriesDir, "metadata.gz"));
      expect(metadata).toHaveLength(2);
      for (const instance of metadata) {
        const sop = instance["00080018"].Value[0];
        expect(instance["7FE00010"].BulkDataURI).toBe(
          `instances/${sop}/frames`
        );
        // nothing stringified to {} — every entry has vr plus content
        for (const entry of Object.values(instance)) {
          expect(
            entry.vr && (entry.Value !== undefined || entry.BulkDataURI)
          ).toBeTruthy();
        }
        const frame = fs.readFileSync(
          path.join(seriesDir, "instances", sop, "frames", "1.mht")
        );
        const text = frame.toString("latin1");
        expect(text).toContain("transfer-syntax=1.2.840.10008.1.2");
        expect(frame.length).toBeGreaterThan(PIXEL_BYTES);
      }
    }
  });

  test("part10 round trip restores byte-identical pixels", async () => {
    const source = path.join(dir, "source");
    const web = path.join(dir, "web");
    const back = path.join(dir, "back");
    writeSourceTree(source);
    expect((await download(source, web)).code).toBe(0);

    const out = capture();
    const err = capture();
    const code = await runTransfer({
      kind: "part10",
      positionals: [web],
      values: { StudyInstanceUID: STUDY_UID, directory: back },
      stdout: out.write,
      stderr: err.write,
    });
    expect(err.lines.join("\n")).toBe("");
    expect(code).toBe(0);

    // find one instance's part10.dcm and compare pixels to its source
    const original = fs.readFileSync(path.join(source, "S1", "IM000001"));
    const originalDict = DicomMessage.readFile(
      original.buffer.slice(
        original.byteOffset,
        original.byteOffset + original.byteLength
      )
    );
    const restoredPath = path.join(
      back,
      "studies",
      STUDY_UID,
      "series",
      "2.25.11",
      "instances",
      "2.25.101",
      "part10.dcm"
    );
    expect(fs.existsSync(restoredPath)).toBe(true);
    const restored = fs.readFileSync(restoredPath);
    const restoredDict = DicomMessage.readFile(
      restored.buffer.slice(
        restored.byteOffset,
        restored.byteOffset + restored.byteLength
      )
    );
    const originalPixels = new Uint8Array(
      originalDict.dict["7FE00010"].Value[0]
    );
    const restoredPixels = new Uint8Array(
      restoredDict.dict["7FE00010"].Value[0]
    );
    expect(restoredPixels.length).toBe(originalPixels.length);
    expect(Buffer.compare(restoredPixels, originalPixels)).toBe(0);
  });

  test("wrong StudyUID lists the studies actually found", async () => {
    const source = path.join(dir, "source");
    writeSourceTree(source);
    const { code, err } = await download(
      source,
      path.join(dir, "web"),
      "9.9.9"
    );
    expect(code).toBe(1);
    const message = err.join("\n");
    expect(message).toMatch(/found these studies instead/);
    expect(message).toContain(STUDY_UID);
  });

  test("static tree as source still works (regression)", async () => {
    const source = path.join(dir, "source");
    const web = path.join(dir, "web");
    const web2 = path.join(dir, "web2");
    writeSourceTree(source);
    expect((await download(source, web)).code).toBe(0);
    // now use the produced tree as a source
    const { code } = await download(web, web2);
    expect(code).toBe(0);
    expect(
      fs.existsSync(path.join(web2, "studies", STUDY_UID, "index.json.gz"))
    ).toBe(true);
  });

  test("missing static index yields the corrective error", async () => {
    const tree = path.join(dir, "tree");
    fs.mkdirSync(path.join(tree, "studies"), { recursive: true });
    const { code, err } = await download(tree, path.join(dir, "web"));
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/does not look like a Static-DICOMweb tree/);
  });
});

describe("dcmjs dicomweb command", () => {
  test("publishes every study found, no -S needed", async () => {
    const source = path.join(dir, "source");
    const dest = path.join(dir, "web");
    writeSourceTree(source);

    const out = capture();
    const err = capture();
    const code = await runDicomweb({
      dcmjs,
      positionals: [source],
      values: { directory: dest },
      stdout: out.write,
      stderr: err.write,
    });
    expect(err.lines.join("\n")).toBe("");
    expect(code).toBe(0);
    expect(out.lines.join("\n")).toContain(`study ${STUDY_UID}`);
    expect(out.lines.join("\n")).toMatch(/1 study published/);
    expect(
      fs.existsSync(path.join(dest, "studies", STUDY_UID, "index.json.gz"))
    ).toBe(true);
  });

  test("icon PixelData is published as bulkdata that resolves", async () => {
    const source = path.join(dir, "source");
    const dest = path.join(dir, "web");
    writeSourceTree(source);
    const iconFile = path.join(source, "S1", "IM000001");
    const buffer = fs.readFileSync(iconFile);
    const dicomDict = DicomMessage.readFile(
      buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength
      )
    );
    const iconBytes = Buffer.from([9, 8, 7, 6, 5, 4, 3, 2]);
    dicomDict.dict["00880200"] = {
      vr: "SQ",
      Value: [{ "7FE00010": { vr: "OB", Value: [iconBytes.buffer.slice(0)] } }],
    };
    fs.writeFileSync(iconFile, Buffer.from(dicomDict.write()));

    const code = await runDicomweb({
      dcmjs,
      positionals: [source],
      values: { directory: dest },
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(0);

    const seriesDir = path.join(
      dest,
      "studies",
      STUDY_UID,
      "series",
      "2.25.11"
    );
    const metadata = gunzipJson(path.join(seriesDir, "metadata.gz"));
    const withIcon = metadata.find((m) => m["00880200"]);
    const uri = withIcon["00880200"].Value[0]["7FE00010"].BulkDataURI;
    expect(uri).not.toMatch(/frames/);
    const stored = fs.readFileSync(path.resolve(seriesDir, uri));
    expect(stored.includes(iconBytes)).toBe(true);
  });

  test("a duplicate SOPInstanceUID is skipped with a warning, not dropped silently", async () => {
    writeSourceTree(dir);
    // same SOP UID as S1/IM000001, in a different series
    writeInstance(path.join(dir, "S3", "COPY"), {
      sopUid: "2.25.101",
      seriesUid: "2.25.33",
      instanceNumber: 1,
    });
    const access = await DicomAccess.createInstance(dir, {});
    const { skipped } = await access.scan();
    expect(skipped).toHaveLength(1);
    expect(skipped[0].file).toMatch(/S3[\\/]COPY$/);
    expect(skipped[0].error).toMatch(/duplicate SOPInstanceUID 2\.25\.101/);
  });

  test("missing directory prints usage", async () => {
    const err = capture();
    const code = await runDicomweb({
      dcmjs,
      positionals: [],
      values: {},
      stdout: capture().write,
      stderr: err.write,
    });
    expect(code).toBe(1);
    expect(err.lines.join("\n")).toMatch(/usage: dcmjs dicomweb/);
  });

  test("empty directory is a corrective error", async () => {
    const empty = path.join(dir, "empty");
    fs.mkdirSync(empty);
    const err = capture();
    const code = await runDicomweb({
      dcmjs,
      positionals: [empty],
      values: { directory: path.join(dir, "web") },
      stdout: capture().write,
      stderr: err.write,
    });
    expect(code).toBe(1);
  });
});

describe("frame extraction", () => {
  const naturalBase = {
    Rows: 4,
    Columns: 4,
    SamplesPerPixel: 1,
    BitsAllocated: 16,
  };

  function entryFor(natural, frameInfo) {
    return { natural, frameInfo, filePath: "test.dcm" };
  }

  test("native multiframe slices by computed frame size", () => {
    const pixels = new Uint16Array(16 * 3);
    for (let i = 0; i < pixels.length; i++) {
      pixels[i] = i;
    }
    const entry = entryFor(
      { ...naturalBase, NumberOfFrames: 3 },
      { encapsulated: false }
    );
    const frame2 = new Uint16Array(extractFrame([pixels.buffer], 2, entry));
    expect(Array.from(frame2)).toEqual(Array.from(pixels.slice(16, 32)));
  });

  test("1-bit frames are packed with no padding between frames", () => {
    // 5x5 frames = 25 bits each; frame 2 starts at bit 25 (byte 3, bit 1).
    const bits = [];
    for (let frame = 0; frame < 3; frame++) {
      for (let i = 0; i < 25; i++) {
        bits.push((i + frame) % 3 === 0 ? 1 : 0);
      }
    }
    const packed = new Uint8Array(Math.ceil(bits.length / 8));
    bits.forEach((bit, i) => {
      packed[i >> 3] |= bit << (i % 8);
    });
    const entry = entryFor(
      { Rows: 5, Columns: 5, BitsAllocated: 1, NumberOfFrames: 3 },
      { encapsulated: false }
    );
    for (let frame = 1; frame <= 3; frame++) {
      const out = new Uint8Array(extractFrame([packed.buffer], frame, entry));
      expect(out.byteLength).toBe(4);
      const got = Array.from(
        { length: 25 },
        (_, i) => (out[i >> 3] >> (i % 8)) & 1
      );
      expect(got).toEqual(bits.slice((frame - 1) * 25, frame * 25));
    }
  });

  test("encapsulated with one fragment per frame maps directly", () => {
    const frames = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
    const entry = entryFor(
      { ...naturalBase, NumberOfFrames: 2 },
      { encapsulated: true }
    );
    expect(Array.from(new Uint8Array(extractFrame(frames, 2, entry)))).toEqual([
      3, 4,
    ]);
  });

  test("single-frame multi-fragment concatenates", () => {
    const fragments = [new Uint8Array([1, 2]), new Uint8Array([3])];
    const entry = entryFor(
      { ...naturalBase, NumberOfFrames: 1 },
      { encapsulated: true }
    );
    expect(
      Array.from(new Uint8Array(extractFrame(fragments, 1, entry)))
    ).toEqual([1, 2, 3]);
  });

  test("fragment/frame mismatch without BOT is a corrective error", () => {
    const fragments = [new Uint8Array(2), new Uint8Array(2), new Uint8Array(2)];
    const entry = entryFor(
      { ...naturalBase, NumberOfFrames: 2 },
      { encapsulated: true }
    );
    expect(() => extractFrame(fragments, 1, entry)).toThrow(
      /cannot split 3 pixel-data fragments into 2 frames/
    );
  });

  test("truncated native pixels report expected vs actual", () => {
    const entry = entryFor(
      { ...naturalBase, NumberOfFrames: 1 },
      { encapsulated: false }
    );
    expect(() => extractFrame([new Uint8Array(10).buffer], 1, entry)).toThrow(
      /10 bytes but 1 frame\(s\).*need 32/
    );
  });
});
