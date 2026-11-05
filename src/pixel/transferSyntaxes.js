// src/pixel/transferSyntaxes.js
//
// The transfer syntaxes `transcode` and `wsiresize` can write, with their
// command-line aliases. Any syntax @cornerstonejs/dicom-codec decodes is
// accepted as input; only these are offered as output.

export const EXPLICIT_LITTLE_ENDIAN = "1.2.840.10008.1.2.1";
export const JPEG_BASELINE = "1.2.840.10008.1.2.4.50";
export const JPEG_LS_LOSSLESS = "1.2.840.10008.1.2.4.80";
export const HTJ2K_LOSSLESS = "1.2.840.10008.1.2.4.201";
export const JPEG_XL_LOSSLESS = "1.2.840.10008.1.2.4.110";
export const JPEG_XL_JPEG_RECOMPRESSION = "1.2.840.10008.1.2.4.111";
export const JPEG_XL = "1.2.840.10008.1.2.4.112";
export const RLE_LOSSLESS = "1.2.840.10008.1.2.5";
export const DEFLATED_IMAGE_FRAME = "1.2.840.10008.1.2.8.1";

/**
 * `lossy` is the default for the syntax; JPEG XL (.112) becomes lossless
 * with `--lossless`. `method` is the (0028,2114) defined term.
 * `bytePreserving` syntaxes keep the native frame bytes exactly, so they
 * take any photometric and Bits Allocated 1 (PS3.5 CP-2301, Sup 244).
 * `maxBits` (and `maxColourBits` for Samples per Pixel > 1) is the largest
 * Bits Allocated that the codec writes exactly; see {@link bitDepthLimit}.
 */
export const OUTPUT_SYNTAXES = [
  {
    uid: EXPLICIT_LITTLE_ENDIAN,
    aliases: ["explicit-le", "native", "uncompressed"],
    name: "Explicit VR Little Endian",
    encapsulated: false,
    lossy: false,
    bytePreserving: true,
  },
  {
    uid: RLE_LOSSLESS,
    aliases: ["rle", "rle-lossless"],
    name: "RLE Lossless",
    encapsulated: true,
    lossy: false,
    bytePreserving: true,
  },
  {
    uid: DEFLATED_IMAGE_FRAME,
    aliases: ["deflate", "frame-deflate"],
    name: "Deflated Image Frame Compression",
    encapsulated: true,
    lossy: false,
    bytePreserving: true,
  },
  {
    uid: JPEG_BASELINE,
    aliases: ["jpeg", "jpeg-baseline"],
    name: "JPEG Baseline",
    encapsulated: true,
    lossy: true,
    method: "ISO_10918_1",
    maxBits: 8,
  },
  {
    uid: JPEG_LS_LOSSLESS,
    aliases: ["jls", "jpeg-ls"],
    name: "JPEG-LS Lossless",
    encapsulated: true,
    lossy: false,
    maxBits: 16,
  },
  {
    uid: HTJ2K_LOSSLESS,
    aliases: ["htj2k", "htj2k-lossless"],
    name: "HTJ2K Lossless",
    encapsulated: true,
    lossy: false,
    // shortcut: the codec changes the values of 32-bit frames and of colour
    // frames over 8 bits (DICOM permits both); raise when
    // https://github.com/cornerstonejs/codecs/issues/98 is fixed.
    maxBits: 16,
    maxColourBits: 8,
  },
  {
    uid: JPEG_XL_LOSSLESS,
    aliases: ["jxl-lossless"],
    name: "JPEG XL Lossless",
    encapsulated: true,
    lossy: false,
    maxBits: 16,
  },
  {
    uid: JPEG_XL_JPEG_RECOMPRESSION,
    aliases: ["jxl-jpeg", "jxl-recompress"],
    name: "JPEG XL JPEG Recompression",
    encapsulated: true,
    lossy: false,
    maxBits: 8,
  },
  {
    uid: JPEG_XL,
    aliases: ["jxl"],
    name: "JPEG XL",
    encapsulated: true,
    lossy: true,
    method: "ISO_18181_1",
    maxBits: 16,
  },
];

export const OUTPUT_ALIASES = OUTPUT_SYNTAXES.map((s) => s.aliases[0]);

/** Looks up an output syntax by alias or UID; throws with the valid choices. */
export function resolveOutputSyntax(nameOrUid) {
  const key = String(nameOrUid ?? "").toLowerCase();
  const found = OUTPUT_SYNTAXES.find(
    (s) => s.uid === key || s.aliases.includes(key)
  );
  if (!found) {
    throw new Error(
      `unknown output transfer syntax '${nameOrUid}' — use one of ` +
        `${OUTPUT_ALIASES.join(", ")}, or the UID`
    );
  }
  return found;
}

/**
 * Why `target` cannot write frames of this depth exactly, or undefined when
 * it can. `encodeFrame` throws with this text, and `selectTargetSyntax`
 * keeps the frame with it.
 */
export function bitDepthLimit(target, { bitsAllocated, samplesPerPixel = 1 }) {
  const colour = samplesPerPixel > 1;
  const max = (colour && target.maxColourBits) || target.maxBits;
  if (max && bitsAllocated > max) {
    return (
      `${target.name} writes at most ${max}-bit ` +
      `${colour ? "colour" : "grayscale"} frames, got Bits Allocated ` +
      `${bitsAllocated}; use deflate, rle or explicit-le`
    );
  }
  return undefined;
}

const DEFLATED_EXPLICIT_LITTLE_ENDIAN = "1.2.840.10008.1.2.1.99";

/**
 * The syntax that describes the frames of a file. A deflated dataset holds
 * native Explicit VR Little Endian pixel data once the reader inflates it.
 */
export const pixelLayoutSyntax = (uid) =>
  uid === DEFLATED_EXPLICIT_LITTLE_ENDIAN ? EXPLICIT_LITTLE_ENDIAN : uid;

const EXPLICIT_BIG_ENDIAN = "1.2.840.10008.1.2.2";

/** Little endian native frames: the same bytes in Explicit VR LE. */
export const isLittleEndianNative = (uid) =>
  isNativeSyntax(uid) && uid !== EXPLICIT_BIG_ENDIAN;

export function isNativeSyntax(uid) {
  return (
    uid === "1.2.840.10008.1.2" ||
    uid === EXPLICIT_LITTLE_ENDIAN ||
    uid === EXPLICIT_BIG_ENDIAN
  );
}

/**
 * Distance for a cjxl-style quality (0..100). The same mapping as
 * cjxl/libjxl's JxlEncoderDistanceFromQuality: quality 90 is distance 1.0
 * (visually lossless), quality 100 is distance 0.
 */
export function distanceFromQuality(quality) {
  if (quality >= 100) {
    return 0;
  }
  if (quality >= 30) {
    return 0.1 + (100 - quality) * 0.09;
  }
  return (53 / 3000) * quality * quality - (23 / 20) * quality + 25;
}
