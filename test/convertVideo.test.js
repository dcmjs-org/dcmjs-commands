// test/convertVideo.test.js
//
// dcmjs convert, video both ways: mp4 → dcm (Supplement 225 encapsulation,
// streamed) and dcm → mp4 (byte-identical stream recovery). The MP4 fixture
// is synthesized in memory (makeTinyMp4) — an odd-length payload, so every
// round trip exercises the pad-byte truncation.

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
import { sniffKind } from "../src/io.js";
import { makeTinyMp4 } from "./utils/makeTinyMp4.js";

const DICOM_FIXTURE = path.join(__dirname, "fixtures", "sample-dicom.dcm");
const H264_HIGH_42 = "1.2.840.10008.1.2.4.104.1";

const { DicomMessage, DicomMetaDictionary } = dcmjs.data;

let dir;
let mp4Path;
const out = [];
const err = [];
const io = {
  stdout: (line) => out.push(line),
  stderr: (line) => err.push(line),
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcmjs-video-"));
  mp4Path = path.join(dir, "movie.mp4");
  fs.writeFileSync(mp4Path, makeTinyMp4());
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  out.length = 0;
  err.length = 0;
});

function readBack(file) {
  const buffer = fs.readFileSync(file);
  const dicomDict = DicomMessage.readFile(
    buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    )
  );
  return {
    meta: DicomMetaDictionary.naturalizeDataset(dicomDict.meta),
    dataset: DicomMetaDictionary.naturalizeDataset(dicomDict.dict),
  };
}

describe("sniffKind mp4", () => {
  it("detects the ftyp magic and the extension fallback", () => {
    expect(sniffKind(mp4Path)).toBe("mp4");
    const renamed = path.join(dir, "movie.bin");
    fs.copyFileSync(mp4Path, renamed);
    expect(sniffKind(renamed)).toBe("mp4"); // magic, not extension
    const stub = path.join(dir, "empty.mp4");
    fs.writeFileSync(stub, "");
    expect(sniffKind(stub)).toBe("mp4"); // extension fallback
  });

  it("DICM still wins over embedded video bytes", () => {
    expect(sniffKind(DICOM_FIXTURE)).toBe("dicom");
  });
});

describe("convert mp4 → dcm", () => {
  it("encapsulates with the Sup 225 layout and the declared total length", async () => {
    const dcmPath = path.join(dir, "movie.dcm");
    const code = await runConvert({
      dcmjs,
      positionals: [mp4Path],
      values: {
        to: "dcm",
        output: dcmPath,
        "patient-name": "DOE^JANE",
        "patient-id": "JD-001",
      },
      ...io,
    });
    expect(code).toBe(0);

    const { meta, dataset } = readBack(dcmPath);
    expect(meta.TransferSyntaxUID).toBe(H264_HIGH_42);
    expect(dataset.Modality).toBe("XC");
    expect([].concat(dataset.PatientName)[0]).toEqual({
      Alphabetic: "DOE^JANE",
    });
    expect(dataset.PatientID).toBe("JD-001");
    expect(dataset.Rows).toBe(48);
    expect(dataset.Columns).toBe(64);
    expect(Number(dataset.NumberOfFrames)).toBe(12);
    expect(dataset.PhotometricInterpretation).toBe("YBR_PARTIAL_420");
    const declared = dataset.EncapsulatedPixelDataValueTotalLength;
    expect(BigInt(Array.isArray(declared) ? declared[0] : declared)).toBe(
      BigInt(fs.statSync(mp4Path).size)
    );
  });

  it("a FHIR Patient beats --patient-name", async () => {
    const patientPath = path.join(dir, "patient.json");
    fs.writeFileSync(
      patientPath,
      JSON.stringify({
        resourceType: "Patient",
        name: [{ use: "official", family: "FOX", given: ["JANE"] }],
        identifier: [{ value: "JF-002" }],
        gender: "female",
      })
    );
    const dcmPath = path.join(dir, "movie-fox.dcm");
    const code = await runConvert({
      dcmjs,
      positionals: [mp4Path],
      values: {
        to: "dcm",
        output: dcmPath,
        "patient-name": "DOE^JANE",
        "fhir-patient": patientPath,
      },
      ...io,
    });
    expect(code).toBe(0);
    const { dataset } = readBack(dcmPath);
    expect([].concat(dataset.PatientName)[0]).toEqual({
      Alphabetic: "FOX^JANE",
    });
    expect(dataset.PatientID).toBe("JF-002");
  });

  it("--fragment-bytes controls the fragment count", async () => {
    const dcmPath = path.join(dir, "movie-frag.dcm");
    const code = await runConvert({
      dcmjs,
      positionals: [mp4Path],
      values: { to: "dcm", output: dcmPath, "fragment-bytes": "512" },
      ...io,
    });
    expect(code).toBe(0);
    const expected = Math.ceil(fs.statSync(mp4Path).size / 512);
    expect(err.join("\n")).toContain(`${expected} fragments`);

    // odd fragment size is a corrective error
    const bad = await runConvert({
      dcmjs,
      positionals: [mp4Path],
      values: {
        to: "dcm",
        output: path.join(dir, "x.dcm"),
        "fragment-bytes": "513",
      },
      ...io,
    });
    expect(bad).toBe(1);
    expect(err.join("\n")).toMatch(/even/);
  });

  it("rejects non-dcm targets and missing -o with corrective errors", async () => {
    expect(
      await runConvert({
        dcmjs,
        positionals: [mp4Path],
        values: { to: "json" },
        ...io,
      })
    ).toBe(1);
    expect(err.join("\n")).toMatch(/mp4 → json/);

    err.length = 0;
    expect(
      await runConvert({
        dcmjs,
        positionals: [mp4Path],
        values: { to: "dcm" },
        ...io,
      })
    ).toBe(1);
    expect(err.join("\n")).toMatch(/-o <file>/);
  });

  it("names the ffmpeg transcode for unsupported codecs", async () => {
    const hevcPath = path.join(dir, "movie-hevc.mp4");
    fs.writeFileSync(hevcPath, makeTinyMp4({ codec: "hev1" }));
    const code = await runConvert({
      dcmjs,
      positionals: [hevcPath],
      values: { to: "dcm", output: path.join(dir, "hevc.dcm") },
      ...io,
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/ffmpeg/);
  });
});

describe("convert dcm → mp4", () => {
  it("recovers the byte-identical MP4 (pad byte dropped)", async () => {
    const dcmPath = path.join(dir, "roundtrip.dcm");
    await runConvert({
      dcmjs,
      positionals: [mp4Path],
      values: { to: "dcm", output: dcmPath, "fragment-bytes": "512" },
      ...io,
    });

    const recovered = path.join(dir, "recovered.mp4");
    const code = await runConvert({
      dcmjs,
      positionals: [dcmPath],
      values: { to: "mp4", output: recovered },
      ...io,
    });
    expect(code).toBe(0);
    const original = fs.readFileSync(mp4Path);
    expect(original.length % 2).toBe(1); // odd → the pad path was real
    expect(Buffer.compare(fs.readFileSync(recovered), original)).toBe(0);
  });

  it("rejects a non-video instance, naming its transfer syntax", async () => {
    const code = await runConvert({
      dcmjs,
      positionals: [DICOM_FIXTURE],
      values: { to: "mp4", output: path.join(dir, "nope.mp4") },
      ...io,
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/not a video instance|no encapsulated/);
    expect(fs.existsSync(path.join(dir, "nope.mp4"))).toBe(false);
  });
});

describe("video instance JSON output", () => {
  it("dump-style JSON no longer chokes on the BigInt total length", async () => {
    const dcmPath = path.join(dir, "movie-json.dcm");
    await runConvert({
      dcmjs,
      positionals: [mp4Path],
      values: { to: "dcm", output: dcmPath },
      ...io,
    });
    out.length = 0;
    const code = await runConvert({
      dcmjs,
      positionals: [dcmPath],
      values: { to: "json" },
      ...io,
    });
    expect(code).toBe(0);
    const dataset = JSON.parse(out.join("\n"));
    expect(dataset.EncapsulatedPixelDataValueTotalLength).toBe(
      fs.statSync(mp4Path).size
    );
  });
});
