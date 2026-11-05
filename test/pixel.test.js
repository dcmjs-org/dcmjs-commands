// test/pixel.test.js
//
// API contract of `@dcmjs/commands/pixel`: the new lossless targets and the
// compression rule.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFLATED_IMAGE_FRAME,
  EXPLICIT_LITTLE_ENDIAN,
  HTJ2K_LOSSLESS,
  JPEG_BASELINE,
  JPEG_LS_LOSSLESS,
  JPEG_XL,
  JPEG_XL_JPEG_RECOMPRESSION,
  JPEG_XL_LOSSLESS,
  RLE_LOSSLESS,
  decodeFrame,
  encodeFrame,
  selectTargetSyntax,
} from "../src/pixel/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function frame(bitsAllocated, signed) {
  const imageInfo = {
    rows: 13,
    columns: 17,
    bitsAllocated,
    samplesPerPixel: 1,
    planarConfiguration: 0,
    pixelRepresentation: signed ? 1 : 0,
    signed,
    photometric: "MONOCHROME2",
  };
  const n = imageInfo.rows * imageInfo.columns;
  const Type =
    bitsAllocated === 8 ? Uint8Array : signed ? Int16Array : Uint16Array;
  const samples = new Type(n);
  // Full range, with large steps, so a lossy encode cannot pass.
  for (let i = 0; i < n; i++) {
    samples[i] = bitsAllocated === 8 ? (i * 31) % 256 : (i * 7919) % 65536;
  }
  return { imageInfo, pixels: new Uint8Array(samples.buffer) };
}

describe("API contract: lossless round trip of the new targets", () => {
  test.each([
    ["JPEG-LS", JPEG_LS_LOSSLESS, 8, false],
    ["JPEG-LS", JPEG_LS_LOSSLESS, 16, false],
    ["JPEG-LS", JPEG_LS_LOSSLESS, 16, true],
    ["HTJ2K", HTJ2K_LOSSLESS, 8, false],
    ["HTJ2K", HTJ2K_LOSSLESS, 16, false],
    ["HTJ2K", HTJ2K_LOSSLESS, 16, true],
  ])("%s %s, %i-bit, signed %s", async (_name, uid, bits, signed) => {
    const { imageInfo, pixels } = frame(bits, signed);
    const encoded = await encodeFrame(pixels, imageInfo, uid);
    const decoded = await decodeFrame(encoded, imageInfo, uid);
    expect(Buffer.from(decoded).equals(Buffer.from(pixels))).toBe(true);
  });
});

const WSI = "1.2.840.10008.5.1.4.1.1.77.1.6";
const CT = "1.2.840.10008.5.1.4.1.1.2";

function metadata({ sop = CT, spp = 1, bits = 16, photometric, lossy } = {}) {
  const dict = {
    "00080016": { vr: "UI", Value: [sop] },
    "00280002": { vr: "US", Value: [spp] },
    "00280100": { vr: "US", Value: [bits] },
    "00280004": {
      vr: "CS",
      Value: [photometric ?? (spp > 1 ? "RGB" : "MONOCHROME2")],
    },
  };
  if (lossy) {
    dict["00282110"] = { vr: "CS", Value: ["01"] };
  }
  return dict;
}

const select = (meta, incomingTransferSyntax) =>
  selectTargetSyntax(meta, { incomingTransferSyntax }).target;

describe("API contract: selectTargetSyntax default rule", () => {
  test("1. video SOP class or video syntax: keep", () => {
    expect(select(metadata({ sop: "1.2.840.10008.5.1.4.1.1.77.1.4.1" }))).toBe(
      null
    );
    expect(select(metadata({ spp: 3 }), "1.2.840.10008.1.2.4.102")).toBe(null);
  });

  test("2. WSI with JPEG Baseline input: JPEG XL JPEG Recompression", () => {
    expect(select(metadata({ sop: WSI, spp: 3, bits: 8 }), JPEG_BASELINE)).toBe(
      JPEG_XL_JPEG_RECOMPRESSION
    );
  });

  test("3. segmentation: Deflated Image Frame, also for 1-bit data", () => {
    const seg = metadata({ sop: "1.2.840.10008.5.1.4.1.1.66.4", bits: 1 });
    expect(select(seg, EXPLICIT_LITTLE_ENDIAN)).toBe(DEFLATED_IMAGE_FRAME);
  });

  test("4. colour: .111 for JPEG, .110 for lossless, .112 for other lossy", () => {
    const rgb = metadata({ spp: 3, bits: 8 });
    expect(select(rgb, JPEG_BASELINE)).toBe(JPEG_XL_JPEG_RECOMPRESSION);
    expect(select(rgb, EXPLICIT_LITTLE_ENDIAN)).toBe(JPEG_XL_LOSSLESS);
    expect(select(rgb, RLE_LOSSLESS)).toBe(JPEG_XL_LOSSLESS);
    expect(select(rgb, "1.2.840.10008.1.2.4.51")).toBe(JPEG_XL);
    expect(
      select(
        metadata({ spp: 3, bits: 8, lossy: true }),
        "1.2.840.10008.1.2.4.91"
      )
    ).toBe(JPEG_XL);
  });

  test("5. grayscale, already compressed: keep", () => {
    expect(select(metadata(), RLE_LOSSLESS)).toBe(null);
    expect(select(metadata(), HTJ2K_LOSSLESS)).toBe(null);
  });

  test("6. grayscale, uncompressed: JPEG-LS lossless", () => {
    expect(select(metadata(), EXPLICIT_LITTLE_ENDIAN)).toBe(JPEG_LS_LOSSLESS);
    expect(select(metadata(), "1.2.840.10008.1.2")).toBe(JPEG_LS_LOSSLESS);
  });

  test("no incoming syntax: Explicit VR LE for images, JPEG Baseline for WSI", () => {
    const image = selectTargetSyntax(metadata());
    expect(image.target).toBe(JPEG_LS_LOSSLESS);
    expect(image.reason).toMatch(/assumed input 1\.2\.840\.10008\.1\.2\.1/);
    expect(select(metadata({ sop: WSI, spp: 3, bits: 8 }))).toBe(
      JPEG_XL_JPEG_RECOMPRESSION
    );
  });

  test("existing limits keep the frame: 1-bit, YBR_FULL", () => {
    expect(select(metadata({ bits: 1 }), EXPLICIT_LITTLE_ENDIAN)).toBe(null);
    const ybr = metadata({ spp: 3, bits: 8, photometric: "YBR_FULL" });
    const result = selectTargetSyntax(ybr, {
      incomingTransferSyntax: EXPLICIT_LITTLE_ENDIAN,
    });
    expect(result.target).toBe(null);
    expect(result.reason).toMatch(/YBR_FULL/);
  });

  test("a JSON table replaces the rules", () => {
    const rules = JSON.parse(
      JSON.stringify([
        { when: { compressed: false }, target: "htj2k", reason: "x" },
      ])
    );
    expect(
      selectTargetSyntax(metadata(), {
        incomingTransferSyntax: EXPLICIT_LITTLE_ENDIAN,
        rules,
      }).target
    ).toBe(HTJ2K_LOSSLESS);
  });
});

test("API contract: ESM import of @dcmjs/commands/pixel", () => {
  const out = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const m = await import('@dcmjs/commands/pixel');" +
        "console.log(typeof m.selectTargetSyntax, typeof m.encodeFrame)",
    ],
    { cwd: ROOT, encoding: "utf8" }
  );
  expect(out.trim()).toBe("function function");
});
