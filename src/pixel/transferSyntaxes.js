// src/pixel/transferSyntaxes.js
//
// The transfer syntaxes `transcode` and `wsiresize` can write, with their
// command-line aliases. Any syntax @cornerstonejs/dicom-codec decodes is
// accepted as input; only these are offered as output.

export const EXPLICIT_LITTLE_ENDIAN = "1.2.840.10008.1.2.1";
export const JPEG_BASELINE = "1.2.840.10008.1.2.4.50";
export const JPEG_XL_LOSSLESS = "1.2.840.10008.1.2.4.110";
export const JPEG_XL_JPEG_RECOMPRESSION = "1.2.840.10008.1.2.4.111";
export const JPEG_XL = "1.2.840.10008.1.2.4.112";

/**
 * `lossy` is the default for the syntax; JPEG XL (.112) becomes lossless
 * with `--lossless`. `method` is the (0028,2114) defined term.
 */
const OUTPUT_SYNTAXES = [
  {
    uid: EXPLICIT_LITTLE_ENDIAN,
    aliases: ["explicit-le", "native", "uncompressed"],
    name: "Explicit VR Little Endian",
    encapsulated: false,
    lossy: false,
  },
  {
    uid: JPEG_BASELINE,
    aliases: ["jpeg", "jpeg-baseline"],
    name: "JPEG Baseline",
    encapsulated: true,
    lossy: true,
    method: "ISO_10918_1",
  },
  {
    uid: JPEG_XL_LOSSLESS,
    aliases: ["jxl-lossless"],
    name: "JPEG XL Lossless",
    encapsulated: true,
    lossy: false,
  },
  {
    uid: JPEG_XL_JPEG_RECOMPRESSION,
    aliases: ["jxl-jpeg", "jxl-recompress"],
    name: "JPEG XL JPEG Recompression",
    encapsulated: true,
    lossy: false,
  },
  {
    uid: JPEG_XL,
    aliases: ["jxl"],
    name: "JPEG XL",
    encapsulated: true,
    lossy: true,
    method: "ISO_18181_1",
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

export function isNativeSyntax(uid) {
  return (
    uid === "1.2.840.10008.1.2" ||
    uid === EXPLICIT_LITTLE_ENDIAN ||
    uid === "1.2.840.10008.1.2.2"
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
