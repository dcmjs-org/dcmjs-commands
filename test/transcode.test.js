// test/transcode.test.js
//
// dcmjs transcode — frame-by-frame transfer syntax conversion.

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { runTranscode } from "../src/commands/transcode.js";
import {
  readPart10Frames,
  readPart10Header,
} from "../src/pixel/frameReader.js";
import { writeSyntheticWsi } from "./helpers/syntheticWsi.js";

const require = createRequire(import.meta.url);
const dcmjs = require("dcmjs");
dcmjs.log.setLevel("silent");

let tmpDir;
let wsi;
beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcmjs-transcode-"));
  wsi = await writeSyntheticWsi(dcmjs, path.join(tmpDir, "source"));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function transcode(positionals, values) {
  const out = [];
  const err = [];
  const code = await runTranscode({
    dcmjs,
    positionals,
    values,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  });
  return { code, text: out.join("\n"), err: err.join("\n") };
}

async function frameHashes(file) {
  const hashes = [];
  await readPart10Frames({
    dcmjs,
    inputPath: file,
    onFrame: async (frame) =>
      hashes.push(crypto.createHash("sha256").update(frame).digest("hex")),
  });
  return hashes;
}

const first = async (file, tag) =>
  (await readPart10Header({ dcmjs, inputPath: file })).dict[tag]?.Value?.[0];

// API: .111 is a lossless container for the JPEG bitstream.
test("jxl-jpeg in place, then jpeg back, gives every JPEG frame byte for byte", async () => {
  const work = path.join(tmpDir, "roundtrip");
  fs.cpSync(path.dirname(wsi.base.path), work, { recursive: true });
  const original = await frameHashes(wsi.base.path);

  const there = await transcode([work], { to: "jxl-jpeg", json: true });
  expect(there.code).toBe(0);
  const report = JSON.parse(there.text);
  expect(report.before.instances).toBe(3);
  expect(report.after.pixelBytes).toBeLessThan(report.before.pixelBytes);
  // Progress goes to stderr, so --json output stays parseable.
  expect(there.err).toBe("transcode: [1-3/3] 3 files, 9 frames");
  const inPlace = path.join(work, "base.dcm");
  expect(
    (await readPart10Header({ dcmjs, inputPath: inPlace })).meta["00020010"]
      .Value[0]
  ).toBe("1.2.840.10008.1.2.4.111");

  const back = path.join(tmpDir, "back");
  expect((await transcode([work], { to: "jpeg", directory: back })).code).toBe(
    0
  );
  const restored = path.join(back, "base.dcm");
  expect(await frameHashes(restored)).toEqual(original);
  expect(await first(restored, "00080018")).toBe(wsi.base.sop);
});

/** A non-image instance in its own series that references `target`. */
function writeAnnotation(file, target, series) {
  const { DicomMetaDictionary, DicomDict } = dcmjs.data;
  const sop = DicomMetaDictionary.uid();
  const dict = DicomMetaDictionary.denaturalizeDataset({
    SOPClassUID: "1.2.840.10008.5.1.4.1.1.91.1",
    SOPInstanceUID: sop,
    StudyInstanceUID: series.study,
    SeriesInstanceUID: DicomMetaDictionary.uid(),
    SeriesDescription: "Annotations",
    SeriesNumber: 7,
    Modality: "ANN",
    ReferencedSeriesSequence: [
      {
        SeriesInstanceUID: series.uid,
        ReferencedInstanceSequence: [
          {
            ReferencedSOPClassUID: "1.2.840.10008.5.1.4.1.1.77.1.6",
            ReferencedSOPInstanceUID: target.sop,
          },
        ],
      },
    ],
  });
  const meta = DicomMetaDictionary.denaturalizeDataset({
    FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
    MediaStorageSOPClassUID: "1.2.840.10008.5.1.4.1.1.91.1",
    MediaStorageSOPInstanceUID: sop,
    TransferSyntaxUID: "1.2.840.10008.1.2.1",
  });
  const part10 = new DicomDict(meta);
  part10.dict = dict;
  fs.writeFileSync(file, Buffer.from(part10.write()));
}

// API: copies that an archive takes as new data, with references kept.
test("--new-series gives new series and instance UIDs, keeps frames and references, and counts copies", async () => {
  const source = path.join(tmpDir, "series-source");
  const copied = await writeSyntheticWsi(dcmjs, source);
  writeAnnotation(path.join(source, "ann.dcm"), copied.base, copied.series);

  const copy1 = path.join(tmpDir, "copy-1");
  const first1 = await transcode([source], {
    "new-series": true,
    directory: copy1,
    json: true,
    quiet: true,
  });
  expect(first1.code).toBe(0);

  const header = async (dir, name) =>
    (await readPart10Header({ dcmjs, inputPath: path.join(dir, name) })).dict;
  const value = (dict, tag) => dict[tag]?.Value?.[0];
  const base = await header(copy1, "base.dcm");
  const half = await header(copy1, "half.dcm");
  const ann = await header(copy1, "ann.dcm");

  const newSeries = value(base, "0020000E");
  expect(newSeries).not.toBe(copied.series.uid);
  expect(value(half, "0020000E")).toBe(newSeries);
  expect(value(base, "00080018")).not.toBe(copied.base.sop);
  expect(value(base, "0020000D")).toBe(copied.series.study);
  expect(value(base, "00200011")).toBe(1000);
  expect(value(base, "0008103E")).toBe("(copy 1)");
  expect(value(ann, "0008103E")).toBe("Annotations (copy 1)");
  expect(value(ann, "00200011")).toBe(1007);
  expect(await frameHashes(path.join(copy1, "base.dcm"))).toEqual(
    await frameHashes(copied.base.path)
  );
  // The annotation now points at the copied series and instance.
  const ref = ann["00081115"].Value[0];
  expect(ref["0020000E"].Value[0]).toBe(newSeries);
  expect(ref["0008114A"].Value[0]["00081155"].Value[0]).toBe(
    value(base, "00080018")
  );

  // A copy of the copy is told apart.
  const copy2 = path.join(tmpDir, "copy-2");
  expect(
    (
      await transcode([copy1], {
        "new-series": true,
        directory: copy2,
        quiet: true,
      })
    ).code
  ).toBe(0);
  const ann2 = await header(copy2, "ann.dcm");
  expect(value(ann2, "0008103E")).toBe("Annotations (copy 2)");
  expect(value(ann2, "00200011")).toBe(2007);
});

// User experience: the originals are never replaced by copies.
test("--new-series needs -d", async () => {
  const { code, err } = await transcode([wsi.base.path], {
    "new-series": true,
  });
  expect(code).toBe(1);
  expect(err).toMatch(/--new-series needs -d <dir>/);
});

// User experience: loss is never silent.
test("a lossy target needs --lossy, and the lossy file gets a new SOPInstanceUID", async () => {
  const refused = await transcode([wsi.base.path], {
    to: "jxl",
    directory: path.join(tmpDir, "refused"),
  });
  expect(refused.code).toBe(1);
  expect(refused.err).toMatch(/pass --lossy/);

  const outDir = path.join(tmpDir, "lossy");
  const lossy = await transcode([wsi.base.path], {
    to: "jxl",
    lossy: true,
    distance: "2",
    directory: outDir,
    quiet: true,
  });
  expect(lossy.code).toBe(0);
  expect(lossy.err).toBe("");
  expect(lossy.text).toMatch(/before .*\n.*after/s);
  const file = path.join(outDir, "base.dcm");
  const { dict } = await readPart10Header({ dcmjs, inputPath: file });
  expect(dict["00080018"].Value[0]).not.toBe(wsi.base.sop);
  expect(dict["00280004"].Value[0]).toBe("RGB");
  expect(dict["00282114"].Value).toEqual(["ISO_10918_1", "ISO_18181_1"]);
  expect(dict["00282112"].Value).toHaveLength(2);
});
