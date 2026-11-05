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
  JPEG_XL_JPEG_RECOMPRESSION,
  JPEG_XL_LOSSLESS,
  RLE_LOSSLESS,
  decodeFrame,
  encodeFrame,
  selectTargetSyntax,
} from "../src/pixel/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function frame(bitsAllocated, signed, samplesPerPixel = 1) {
  const imageInfo = {
    rows: 13,
    columns: 17,
    bitsAllocated,
    samplesPerPixel,
    planarConfiguration: 0,
    pixelRepresentation: signed ? 1 : 0,
    signed,
    photometric: samplesPerPixel > 1 ? "RGB" : "MONOCHROME2",
  };
  const n = imageInfo.rows * imageInfo.columns * samplesPerPixel;
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
    // Every row has the same length: jest passes `done` for a missing value.
    ["JPEG-LS", JPEG_LS_LOSSLESS, 8, false, 1],
    ["JPEG-LS", JPEG_LS_LOSSLESS, 16, false, 1],
    ["JPEG-LS", JPEG_LS_LOSSLESS, 16, true, 1],
    ["HTJ2K", HTJ2K_LOSSLESS, 8, false, 1],
    ["HTJ2K", HTJ2K_LOSSLESS, 16, false, 1],
    ["HTJ2K", HTJ2K_LOSSLESS, 16, true, 1],
    // The default rule sends 16-bit RGB here.
    ["JPEG XL Lossless RGB", JPEG_XL_LOSSLESS, 16, false, 3],
  ])("%s %s, %i-bit, signed %s", async (_name, uid, bits, signed, spp) => {
    const { imageInfo, pixels } = frame(bits, signed, spp);
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

  test("3. segmentation: Deflated Image Frame, also for 1-bit data; compressed kept", () => {
    const seg = metadata({ sop: "1.2.840.10008.5.1.4.1.1.66.4", bits: 1 });
    expect(select(seg, EXPLICIT_LITTLE_ENDIAN)).toBe(DEFLATED_IMAGE_FRAME);
    expect(select(seg, RLE_LOSSLESS)).toBe(null);
  });

  test("4. colour: .111 for JPEG, .110 for uncompressed (also 16-bit), other compressed input kept", () => {
    const rgb = metadata({ spp: 3, bits: 8 });
    expect(select(rgb, JPEG_BASELINE)).toBe(JPEG_XL_JPEG_RECOMPRESSION);
    expect(select(rgb, EXPLICIT_LITTLE_ENDIAN)).toBe(JPEG_XL_LOSSLESS);
    expect(select(metadata({ spp: 3, bits: 16 }), EXPLICIT_LITTLE_ENDIAN)).toBe(
      JPEG_XL_LOSSLESS
    );
    expect(select(rgb, RLE_LOSSLESS)).toBe(null);
    expect(select(rgb, "1.2.840.10008.1.2.4.51")).toBe(null);
    expect(select(rgb, "1.2.840.10008.1.2.4.91")).toBe(null);
  });

  test("5. grayscale, already compressed: keep", () => {
    expect(select(metadata(), RLE_LOSSLESS)).toBe(null);
    expect(select(metadata(), HTJ2K_LOSSLESS)).toBe(null);
    // The decoders read little endian only, so big endian stays as it is.
    expect(select(metadata(), "1.2.840.10008.1.2.2")).toBe(null);
  });

  test("6. grayscale, uncompressed: JPEG-LS lossless", () => {
    expect(select(metadata(), EXPLICIT_LITTLE_ENDIAN)).toBe(JPEG_LS_LOSSLESS);
    expect(select(metadata(), "1.2.840.10008.1.2")).toBe(JPEG_LS_LOSSLESS);
  });

  test("no incoming syntax: native little endian, also for WSI", () => {
    const image = selectTargetSyntax(metadata());
    expect(image.target).toBe(JPEG_LS_LOSSLESS);
    expect(image.reason).toMatch(/assumed input 1\.2\.840\.10008\.1\.2\.1/);
    expect(image.incoming).toBe(EXPLICIT_LITTLE_ENDIAN);
    expect(select(metadata({ sop: WSI, spp: 3, bits: 8 }))).toBe(
      JPEG_XL_LOSSLESS
    );
  });

  test("limits keep the frame: 1-bit, 32-bit, YBR_FULL", () => {
    expect(select(metadata({ bits: 1 }), EXPLICIT_LITTLE_ENDIAN)).toBe(null);
    // User experience: 32-bit data never changes, whatever the table says.
    const dose = metadata({ bits: 32 });
    const deflateAll = [{ when: {}, target: "deflate", reason: "all" }];
    for (const rules of [undefined, deflateAll]) {
      expect(
        selectTargetSyntax(dose, {
          incomingTransferSyntax: EXPLICIT_LITTLE_ENDIAN,
          rules,
        })
      ).toMatchObject({
        target: null,
        reason: "Bits Allocated 32 stays unchanged",
      });
    }
    // An unknown depth can be 32-bit, so it stays unchanged too.
    const noBits = metadata();
    delete noBits["00280100"];
    expect(select(noBits, EXPLICIT_LITTLE_ENDIAN)).toBe(null);
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

  test("a table with an unknown 'when' key or target fails, even when no rule matches", () => {
    const meta = metadata();
    const opts = (rules) => ({ incomingTransferSyntax: RLE_LOSSLESS, rules });
    expect(() =>
      selectTargetSyntax(meta, opts([{ when: { color: true }, target: null }]))
    ).toThrow(/unknown 'when' key 'color'/);
    expect(() =>
      selectTargetSyntax(
        meta,
        opts([{ when: { compressed: false }, target: "nope" }])
      )
    ).toThrow(/rule 0: unknown output transfer syntax 'nope'/);
  });
});

test("API contract: HTJ2K refuses colour over 8 bits, which the codec does not keep exactly", async () => {
  const imageInfo = {
    ...frame(16, false).imageInfo,
    samplesPerPixel: 3,
    photometric: "RGB",
  };
  const pixels = new Uint8Array(13 * 17 * 3 * 2);
  await expect(encodeFrame(pixels, imageInfo, HTJ2K_LOSSLESS)).rejects.toThrow(
    /at most 8-bit colour/
  );
  // RLE: PS3.5 Table 8.2.2-1 permits at most 16 bits.
  const gray32 = { ...frame(16, false).imageInfo, bitsAllocated: 32 };
  await expect(
    encodeFrame(new Uint8Array(13 * 17 * 4), gray32, RLE_LOSSLESS)
  ).rejects.toThrow(/RLE Lossless writes at most 16-bit/);
  const rules = [{ when: {}, target: "htj2k", reason: "all" }];
  expect(
    selectTargetSyntax(metadata({ spp: 3, bits: 16 }), {
      incomingTransferSyntax: EXPLICIT_LITTLE_ENDIAN,
      rules,
    }).target
  ).toBe(null);
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
