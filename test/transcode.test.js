// test/transcode.test.js
//
// dcmjs transcode — frame-by-frame transfer syntax conversion.

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import zlib from "node:zlib";
import dcmjs from "../src/dcmjsBundle.js";
import { runTranscode } from "../src/commands/transcode.js";
import {
  readPart10Frames,
  readPart10Header,
} from "../src/pixel/frameReader.js";
import { writeSyntheticWsi } from "./helpers/syntheticWsi.js";

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

/** A native Explicit VR Little Endian image with `attributes` and `pixels`. */
function writeNative(file, attributes, pixels) {
  const { DicomMetaDictionary, DicomDict } = dcmjs.data;
  const sop = DicomMetaDictionary.uid();
  const dict = DicomMetaDictionary.denaturalizeDataset({
    SOPInstanceUID: sop,
    PixelRepresentation: 0,
    ...attributes,
  });
  const meta = DicomMetaDictionary.denaturalizeDataset({
    FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
    MediaStorageSOPClassUID: attributes.SOPClassUID,
    MediaStorageSOPInstanceUID: sop,
    TransferSyntaxUID: "1.2.840.10008.1.2.1",
  });
  dict["7FE00010"] = {
    vr: "OB",
    Value: [
      pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.length),
    ],
  };
  const part10 = new DicomDict(meta);
  part10.dict = dict;
  fs.writeFileSync(file, Buffer.from(part10.write()));
}

/** A native 1-bit BINARY SEG of three 16x16 frames. */
function writeBinarySeg(file) {
  const pixels = crypto.randomBytes(3 * 32);
  pixels.fill(0, 0, 16); // long runs as well as noise
  writeNative(
    file,
    {
      SOPClassUID: "1.2.840.10008.5.1.4.1.1.66.4",
      Modality: "SEG",
      SegmentationType: "BINARY",
      SamplesPerPixel: 1,
      PhotometricInterpretation: "MONOCHROME2",
      NumberOfFrames: 3,
      Rows: 16,
      Columns: 16,
      BitsAllocated: 1,
      BitsStored: 1,
      HighBit: 0,
    },
    pixels
  );
}

/** Native 8-bit colour: two 4x2 frames, each sample value its own index. */
function writeColor(file, attributes, bytesPerFrame) {
  const pixels = Buffer.alloc(2 * bytesPerFrame);
  pixels.forEach((_, i) => (pixels[i] = i));
  writeNative(
    file,
    {
      SOPClassUID: "1.2.840.10008.5.1.4.1.1.7",
      Modality: "OT",
      SamplesPerPixel: 3,
      NumberOfFrames: 2,
      Rows: 2,
      Columns: 4,
      BitsAllocated: 8,
      BitsStored: 8,
      HighBit: 7,
      ...attributes,
    },
    pixels
  );
  return pixels;
}

async function frames(file) {
  const all = [];
  await readPart10Frames({
    dcmjs,
    inputPath: file,
    onFrame: async (frame) => all.push([...frame]),
  });
  return all;
}

// API: the written header always describes the written samples.
test("planar RGB and native YBR_FULL_422 are written as interleaved full-resolution samples", async () => {
  const dir = path.join(tmpDir, "color");
  fs.mkdirSync(dir, { recursive: true });
  const planar = writeColor(
    path.join(dir, "planar.dcm"),
    { PhotometricInterpretation: "RGB", PlanarConfiguration: 1 },
    24
  );
  const ybr = writeColor(
    path.join(dir, "ybr.dcm"),
    { PhotometricInterpretation: "YBR_FULL_422", PlanarConfiguration: 0 },
    16
  );

  let previous = dir;
  for (const to of ["rle", "deflate", "explicit-le"]) {
    const out = path.join(tmpDir, `color-${to}`);
    expect((await transcode([previous], { to, directory: out })).code).toBe(0);
    previous = out;
  }

  // Planar R R .. G G .. B B .. per frame becomes R G B R G B ..
  const interleaved = (f) =>
    Array.from(
      { length: 24 },
      (_, i) => planar[f * 24 + (i % 3) * 8 + Math.floor(i / 3)]
    );
  expect(await frames(path.join(previous, "planar.dcm"))).toEqual([
    interleaved(0),
    interleaved(1),
  ]);
  // Y0 Y1 Cb Cr becomes Y0 Cb Cr Y1 Cb Cr.
  const upsampled = (f) =>
    Array.from({ length: 4 }, (_, k) => {
      const [y0, y1, cb, cr] = ybr.subarray(f * 16 + k * 4, f * 16 + k * 4 + 4);
      return [y0, cb, cr, y1, cb, cr];
    }).flat();
  expect(await frames(path.join(previous, "ybr.dcm"))).toEqual([
    upsampled(0),
    upsampled(1),
  ]);

  const header = async (name) =>
    (await readPart10Header({ dcmjs, inputPath: path.join(previous, name) }))
      .dict;
  expect((await header("planar.dcm"))["00280006"].Value[0]).toBe(0);
  expect((await header("ybr.dcm"))["00280004"].Value[0]).toBe("YBR_FULL");
});

// User experience: with -d, no file is done twice, and no output replaces another.
test("a file given twice is transcoded once, and two inputs cannot write one output", async () => {
  const study1 = path.join(tmpDir, "inputs", "study1");
  const study2 = path.join(tmpDir, "inputs", "study2");
  for (const dir of [study1, study2]) {
    fs.mkdirSync(dir, { recursive: true });
    writeBinarySeg(path.join(dir, "seg.dcm"));
  }
  const twice = await transcode([study1, path.join(study1, "seg.dcm")], {
    to: "deflate",
    directory: path.join(tmpDir, "inputs-once"),
    json: true,
    quiet: true,
  });
  expect(twice.code).toBe(0);
  expect(JSON.parse(twice.text).files).toHaveLength(1);

  const both = await transcode([study1, study2], {
    to: "deflate",
    directory: path.join(tmpDir, "inputs-both"),
    quiet: true,
  });
  expect(both.code).toBe(1);
  expect(both.err).toMatch(/is already the output of/);

  // -d into the input directory would replace the inputs (TC-U2).
  const before = fs.readFileSync(path.join(study1, "seg.dcm"));
  const itself = await transcode([study1], {
    to: "rle",
    directory: study1,
    quiet: true,
  });
  expect(itself.code).toBe(1);
  expect(itself.err).toMatch(/would replace/);
  expect(fs.readFileSync(path.join(study1, "seg.dcm")).equals(before)).toBe(
    true
  );
});

// User experience: a native thumbnail is valid in any syntax, so it stays.
test("a native Icon Image Sequence stays when the pixel data is re-encoded", async () => {
  const file = path.join(tmpDir, "icon", "planar.dcm");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeColor(
    file,
    {
      PhotometricInterpretation: "RGB",
      PlanarConfiguration: 0,
      IconImageSequence: [
        {
          Rows: 2,
          Columns: 2,
          SamplesPerPixel: 1,
          PhotometricInterpretation: "MONOCHROME2",
          BitsAllocated: 8,
          BitsStored: 8,
          HighBit: 7,
          PixelRepresentation: 0,
          PixelData: new Uint8Array([1, 2, 3, 4]).buffer,
        },
      ],
    },
    24
  );
  const out = path.join(tmpDir, "icon-rle");
  expect(
    (await transcode([file], { to: "rle", directory: out, quiet: true })).code
  ).toBe(0);
  const { dict } = await readPart10Header({
    dcmjs,
    inputPath: path.join(out, "planar.dcm"),
  });
  expect(dict["00880200"].Value[0]["00280010"].Value[0]).toBe(2);
});

// API: a copy keeps fragments that are not one per frame, as video has.
test("--new-series copies a video whose fragments are not one per frame", async () => {
  const { DicomMetaDictionary, DicomDict } = dcmjs.data;
  const MPEG2 = "1.2.840.10008.1.2.4.100";
  const sop = DicomMetaDictionary.uid();
  const dict = DicomMetaDictionary.denaturalizeDataset({
    SOPClassUID: "1.2.840.10008.5.1.4.1.1.77.1.4.1",
    SOPInstanceUID: sop,
    SeriesInstanceUID: DicomMetaDictionary.uid(),
    Modality: "ES",
    NumberOfFrames: 3,
    Rows: 16,
    Columns: 16,
    SamplesPerPixel: 3,
    PhotometricInterpretation: "YBR_PARTIAL_420",
    BitsAllocated: 8,
    BitsStored: 8,
    HighBit: 7,
    PixelRepresentation: 0,
  });
  // Two fragments of one stream for three frames.
  dict["7FE00010"] = {
    vr: "OB",
    Value: [crypto.randomBytes(40), crypto.randomBytes(24)].map((b) =>
      b.buffer.slice(b.byteOffset, b.byteOffset + b.length)
    ),
  };
  const meta = DicomMetaDictionary.denaturalizeDataset({
    FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
    MediaStorageSOPClassUID: "1.2.840.10008.5.1.4.1.1.77.1.4.1",
    MediaStorageSOPInstanceUID: sop,
    TransferSyntaxUID: MPEG2,
  });
  const source = path.join(tmpDir, "video");
  fs.mkdirSync(source, { recursive: true });
  const part10 = new DicomDict(meta);
  part10.dict = dict;
  fs.writeFileSync(
    path.join(source, "video.dcm"),
    Buffer.from(part10.write({ fragmentMultiframe: false }))
  );

  const out = path.join(tmpDir, "video-copy");
  const result = await transcode([source], {
    "new-series": true,
    directory: out,
    quiet: true,
  });
  expect(result.code).toBe(0);
  expect(await frameHashes(path.join(out, "video.dcm"))).toEqual(
    await frameHashes(path.join(source, "video.dcm"))
  );
  // Two fragments for three frames: the Basic Offset Table must be empty,
  // because it needs one entry for each frame.
  const bytes = fs.readFileSync(path.join(out, "video.dcm"));
  const element = bytes.lastIndexOf(
    Buffer.from([0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42])
  );
  expect(bytes.readUInt32LE(element + 16)).toBe(0);
});

// User experience: a header that cannot split the pixel data changes nothing.
test("a native file without Rows fails, and the file stays as it was", async () => {
  const file = path.join(tmpDir, "no-rows.dcm");
  writeNative(
    file,
    {
      SOPClassUID: "1.2.840.10008.5.1.4.1.1.7",
      SamplesPerPixel: 1,
      PhotometricInterpretation: "MONOCHROME2",
      Columns: 4,
      BitsAllocated: 8,
      BitsStored: 8,
      HighBit: 7,
    },
    Buffer.alloc(16, 7)
  );
  const before = fs.readFileSync(file);
  const { code, err } = await transcode([file], { to: "deflate", quiet: true });
  expect(code).toBe(1);
  expect(err).toMatch(/Rows, Columns and BitsAllocated must be/);
  expect(fs.readFileSync(file).equals(before)).toBe(true);
});

// API: 1-bit frames keep every bit through rle and deflate (CP-2301, Sup 244).
test("a BINARY SEG round trips through rle, deflate and explicit-le", async () => {
  const source = path.join(tmpDir, "binary", "seg.dcm");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  writeBinarySeg(source);
  const original = await frameHashes(source);
  expect(original).toHaveLength(3);

  let previous = source;
  for (const to of ["rle", "deflate", "explicit-le"]) {
    const dir = path.join(tmpDir, `binary-${to}`);
    const result = await transcode([previous], {
      to,
      directory: dir,
      quiet: true,
    });
    expect(result.code).toBe(0);
    previous = path.join(dir, "seg.dcm");
  }
  expect(await frameHashes(previous)).toEqual(original);
});

// User experience: a 1-bit file is not silently written where it is not defined.
test("a BINARY SEG cannot be written as JPEG XL", async () => {
  const source = path.join(tmpDir, "binary-jxl-source.dcm");
  writeBinarySeg(source);
  const { code, err } = await transcode([source], {
    to: "jxl-lossless",
    directory: path.join(tmpDir, "binary-jxl"),
    quiet: true,
  });
  expect(code).toBe(1);
  expect(err).toMatch(/Bits Allocated 1 can be written only as/);
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

// API: libjpeg-turbo gives RGB for a JPEG labelled YBR_FULL (TC-U13).
test("a JPEG labelled YBR_FULL is written as RGB samples with an RGB header", async () => {
  const source = path.join(tmpDir, "ybr-full");
  await writeSyntheticWsi(dcmjs, source, { photometric: "YBR_FULL" });
  // jxl-jpeg keeps the JPEG bitstream and its label; its decode is RGB too.
  const recompressed = path.join(tmpDir, "ybr-full-111");
  expect(
    (
      await transcode([path.join(source, "base.dcm")], {
        to: "jxl-jpeg",
        directory: recompressed,
        quiet: true,
      })
    ).code
  ).toBe(0);
  expect(await first(path.join(recompressed, "base.dcm"), "00280004")).toBe(
    "YBR_FULL"
  );

  for (const input of [source, recompressed]) {
    const out = `${input}-le`;
    const result = await transcode([path.join(input, "base.dcm")], {
      to: "explicit-le",
      directory: out,
      quiet: true,
    });
    expect(result.code).toBe(0);
    const file = path.join(out, "base.dcm");
    expect(await first(file, "00280004")).toBe("RGB");
    // Frame 0 is the tile at (256, 256); its first pixel in the RGB pattern
    // of the helper is about (109, 163, 131).
    const [frame] = await frames(file);
    [109, 163, 131].forEach((v, c) =>
      expect(Math.abs(frame[c] - v)).toBeLessThanOrEqual(4)
    );
  }
});

/**
 * Rewrites a native Explicit VR Little Endian `file` as Deflated Explicit VR
 * Little Endian (.1.2.1.99): the same meta, then the deflated dataset.
 */
async function deflateDataset(file) {
  const bytes = fs.readFileSync(file);
  const bodyStart = 144 + bytes.readUInt32LE(140);
  const { meta } = await readPart10Header({ dcmjs, inputPath: file });
  meta["00020010"] = { vr: "UI", Value: ["1.2.840.10008.1.2.1.99"] };
  const head = new dcmjs.data.DicomDict(meta);
  head.dict = {};
  const headBytes = Buffer.from(head.write());
  const metaEnd = 144 + headBytes.readUInt32LE(140);
  fs.writeFileSync(
    file,
    Buffer.concat([
      headBytes.subarray(0, metaEnd),
      zlib.deflateRawSync(bytes.subarray(bodyStart)),
    ])
  );
}

// API: a deflated dataset holds native frames; the copy must stay readable.
test("--new-series copies a Deflated Explicit VR Little Endian file as explicit-le with the same frames", async () => {
  const source = path.join(tmpDir, "deflated");
  fs.mkdirSync(source, { recursive: true });
  const file = path.join(source, "planar.dcm");
  writeColor(
    file,
    { PhotometricInterpretation: "RGB", PlanarConfiguration: 0 },
    24
  );
  const original = await frames(file);
  await deflateDataset(file);
  expect(
    (await readPart10Header({ dcmjs, inputPath: file })).meta["00020010"]
      .Value[0]
  ).toBe("1.2.840.10008.1.2.1.99");

  const out = path.join(tmpDir, "deflated-copy");
  const result = await transcode([source], {
    "new-series": true,
    directory: out,
    quiet: true,
  });
  expect(result.code).toBe(0);
  const copy = path.join(out, "planar.dcm");
  const { meta } = await readPart10Header({ dcmjs, inputPath: copy });
  expect(meta["00020010"].Value[0]).toBe("1.2.840.10008.1.2.1");
  expect(await frames(copy)).toEqual(original);
});
