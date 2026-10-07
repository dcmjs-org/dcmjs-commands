// test/convertImage.test.js
//
// convert with PNG input: sniffing, sidecar discovery, geometry cross-checks,
// --restore-values math, and the conformance the dcmjs library applies
// (fresh SOPInstanceUID, DERIVED\SECONDARY) — end to end through the real
// bundle, writing real Part 10 and reading it back.

import fs from "fs";
import os from "os";
import path from "path";
import { PNG } from "pngjs";
import { createRequire } from "node:module";
import { runConvert } from "../src/commands/convert.js";
import { sniffKind } from "../src/io.js";

const require = createRequire(import.meta.url);
const dcmjs = require("dcmjs");
dcmjs.log.setLevel("silent");

const { DicomMessage, DicomMetaDictionary } = dcmjs.data;

const SOURCE_SOP_INSTANCE_UID = "2.25.111222333444";
const MR_SOP_CLASS_UID = "1.2.840.10008.5.1.4.1.1.4";

let dir;

/** An 8x8 gray ramp PNG (gray stored as RGB — the export-pipeline shape). */
function writeRampPng(filePath) {
  const png = new PNG({ width: 8, height: 8 });
  for (let i = 0; i < 64; i++) {
    const value = i * 4; // 0..252 ramp
    png.data[i * 4] = value;
    png.data[i * 4 + 1] = value;
    png.data[i * 4 + 2] = value;
    png.data[i * 4 + 3] = 255;
  }
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

function sidecar(extra = {}) {
  return {
    png: "ramp.png",
    provenance: { png_is_lossy_8bit: true },
    "00080060": { vr: "CS", Value: ["MR"] },
    "00080016": { vr: "UI", Value: [MR_SOP_CLASS_UID] },
    "00080018": { vr: "UI", Value: [SOURCE_SOP_INSTANCE_UID] },
    "00100010": { vr: "PN", Value: [{ Alphabetic: "DOE^JANE" }] },
    "00100020": { vr: "LO", Value: ["998877"] },
    "0020000D": { vr: "UI", Value: ["1.2.3.4"] },
    ...extra,
  };
}

function capture() {
  const lines = [];
  return { write: (text) => lines.push(text), lines };
}

async function convert(positionals, values = {}) {
  const out = capture();
  const err = capture();
  const code = await runConvert({
    dcmjs,
    positionals,
    values,
    stdout: out.write,
    stderr: err.write,
  });
  return { code, out: out.lines, err: err.lines };
}

function readDcm(filePath) {
  const buffer = fs.readFileSync(filePath);
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
  const dicomDict = DicomMessage.readFile(arrayBuffer);
  return DicomMetaDictionary.naturalizeDataset(dicomDict.dict);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "convert-image-"));
  writeRampPng(path.join(dir, "ramp.png"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sniffKind detects png and jpeg magic", () => {
  expect(sniffKind(path.join(dir, "ramp.png"))).toBe("png");
  const jpegPath = path.join(dir, "x.bin");
  fs.writeFileSync(jpegPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]));
  expect(sniffKind(jpegPath)).toBe("jpeg");
});

test("png + auto-discovered sidecar → derived MR instance", async () => {
  fs.writeFileSync(path.join(dir, "ramp.json"), JSON.stringify(sidecar()));
  const outPath = path.join(dir, "out.dcm");
  const { code, err } = await convert([path.join(dir, "ramp.png")], {
    to: "dcm",
    output: outPath,
  });
  expect(code).toBe(0);

  const dataset = readDcm(outPath);
  expect(dataset.Rows).toBe(8);
  expect(dataset.Columns).toBe(8);
  expect(dataset.SamplesPerPixel).toBe(1); // gray-in-RGB collapsed
  expect(dataset.PhotometricInterpretation).toBe("MONOCHROME2");
  expect(String(dataset.PatientName)).toBe("DOE^JANE");
  expect(dataset.StudyInstanceUID).toBe("1.2.3.4");
  expect(dataset.SOPClassUID).toBe(MR_SOP_CLASS_UID);
  // conformance: never the source UID, marked derived
  expect(dataset.SOPInstanceUID).not.toBe(SOURCE_SOP_INSTANCE_UID);
  expect(dataset.ImageType).toEqual(["DERIVED", "SECONDARY"]);
  expect(dataset.SourceImageSequence[0].ReferencedSOPInstanceUID).toBe(
    SOURCE_SOP_INSTANCE_UID
  );
  expect(err.join("\n")).toContain("ignored non-DICOM sidecar keys");
});

test("bare png (no sidecar) converts as Secondary Capture", async () => {
  const outPath = path.join(dir, "out.dcm");
  const { code } = await convert([path.join(dir, "ramp.png")], {
    to: "dcm",
    output: outPath,
  });
  expect(code).toBe(0);
  const dataset = readDcm(outPath);
  expect(dataset.SOPClassUID).toBe("1.2.840.10008.5.1.4.1.1.7");
  expect(dataset.ImageType).toEqual(["ORIGINAL", "PRIMARY"]);
});

test("dimension mismatch is a hard, corrective error", async () => {
  fs.writeFileSync(
    path.join(dir, "ramp.json"),
    JSON.stringify(
      sidecar({
        "00280010": { vr: "US", Value: [1024] },
        "00280011": { vr: "US", Value: [1024] },
      })
    )
  );
  const { code, err } = await convert([path.join(dir, "ramp.png")], {
    to: "dcm",
    output: path.join(dir, "out.dcm"),
  });
  expect(code).toBe(1);
  expect(err.join("\n")).toMatch(/8x8 but metadata claims/);
  expect(err.join("\n")).toMatch(/fix the sidecar/);
});

test("BitsStored claim without --restore-values warns and proceeds 8-bit", async () => {
  fs.writeFileSync(
    path.join(dir, "ramp.json"),
    JSON.stringify(sidecar({ "00280101": { vr: "US", Value: [12] } }))
  );
  const outPath = path.join(dir, "out.dcm");
  const { code, err } = await convert([path.join(dir, "ramp.png")], {
    to: "dcm",
    output: outPath,
  });
  expect(code).toBe(0);
  expect(err.join("\n")).toMatch(/pass --restore-values/);
  expect(readDcm(outPath).BitsStored).toBe(8);
});

test("--restore-values inverts the window transform exactly", async () => {
  const windowCenter = 312;
  const windowWidth = 673;
  fs.writeFileSync(
    path.join(dir, "ramp.json"),
    JSON.stringify(
      sidecar({
        "00281050": { vr: "DS", Value: [windowCenter] },
        "00281051": { vr: "DS", Value: [windowWidth] },
        "00280101": { vr: "US", Value: [12] },
      })
    )
  );
  const outPath = path.join(dir, "out.dcm");
  const { code } = await convert([path.join(dir, "ramp.png")], {
    to: "dcm",
    output: outPath,
    "restore-values": true,
  });
  expect(code).toBe(0);

  const dataset = readDcm(outPath);
  expect(dataset.BitsAllocated).toBe(16);
  expect(dataset.BitsStored).toBe(12);
  expect(dataset.LossyImageCompression).toBe("01");

  let payload = dataset.PixelData;
  if (Array.isArray(payload)) {
    payload = payload[0];
  }
  const pixels = new Uint16Array(
    payload instanceof ArrayBuffer ? payload : payload.buffer
  );
  // spot-check the inverse VOI formula on the ramp
  for (const i of [0, 13, 42, 63]) {
    const p = Math.min(255, i * 4);
    const expected = Math.min(
      4095,
      Math.max(
        0,
        Math.round((p / 255 - 0.5) * (windowWidth - 1) + (windowCenter - 0.5))
      )
    );
    expect(pixels[i]).toBe(expected);
  }
});

test("--restore-values without window metadata is a corrective error", async () => {
  fs.writeFileSync(path.join(dir, "ramp.json"), JSON.stringify(sidecar()));
  const { code, err } = await convert([path.join(dir, "ramp.png")], {
    to: "dcm",
    output: path.join(dir, "out.dcm"),
    "restore-values": true,
  });
  expect(code).toBe(1);
  expect(err.join("\n")).toMatch(/WindowCenter/);
});

test("explicit --metadata that does not exist is an error", async () => {
  const { code, err } = await convert([path.join(dir, "ramp.png")], {
    to: "dcm",
    output: path.join(dir, "out.dcm"),
    metadata: path.join(dir, "missing.json"),
  });
  expect(code).toBe(1);
  expect(err.join("\n")).toMatch(/metadata file not found/);
});

test("png → dicomweb-json", async () => {
  fs.writeFileSync(path.join(dir, "ramp.json"), JSON.stringify(sidecar()));
  const { code, out } = await convert([path.join(dir, "ramp.png")], {
    to: "dicomweb-json",
  });
  expect(code).toBe(0);
  const json = JSON.parse(out.join(""));
  expect(Number(json["00280010"].Value[0])).toBe(8);
  expect(json["00100020"].Value[0]).toBe("998877");
});
