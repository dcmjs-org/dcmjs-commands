// src/pixel/pixelHeader.js
//
// Header updates for re-encoded pixel data, shared by `transcode` and
// `wsiresize`. Datasets are tag-keyed `{ vr, Value }` dicts.

import { hasNativeLayout, isBitstreamTranscode } from "./codec.js";

/**
 * Image decoders hand these back as RGB; the others come back unchanged.
 * Native YBR_FULL_422 is upsampled to YBR_FULL instead (see decodeFrame).
 */
const DECODED_AS_RGB = new Set([
  "YBR_FULL_422",
  "YBR_PARTIAL_420",
  "YBR_ICT",
  "YBR_RCT",
]);

/**
 * Syntaxes whose decoder converts YBR_FULL to RGB too: JPEG Baseline and
 * Extended (libjpeg-turbo), and JPEG XL JPEG Recompression, which keeps the
 * JPEG label but decodes to RGB.
 */
const DECODES_YBR_FULL_AS_RGB = new Set([
  "1.2.840.10008.1.2.4.50",
  "1.2.840.10008.1.2.4.51",
  "1.2.840.10008.1.2.4.111",
]);

const set = (dict, tag, vr, ...Value) => {
  dict[tag] = { vr, Value };
};
const first = (dict, tag) => dict[tag]?.Value?.[0];

/**
 * The PhotometricInterpretation after `source` → `target`, or throws for a
 * colour model that the target codec would misread. `lossy` is whether this
 * encode loses data; JPEG XL with `--lossless` does not.
 */
export function photometricAfter({
  photometric,
  sourceUid,
  target,
  lossy = target.lossy,
}) {
  if (isBitstreamTranscode(sourceUid, target.uid)) {
    return photometric;
  }
  const decoded = hasNativeLayout(sourceUid)
    ? photometric === "YBR_FULL_422"
      ? "YBR_FULL"
      : photometric
    : DECODED_AS_RGB.has(photometric) ||
        (photometric === "YBR_FULL" && DECODES_YBR_FULL_AS_RGB.has(sourceUid))
      ? "RGB"
      : photometric;
  if (target.uid === "1.2.840.10008.1.2.4.50" && decoded === "RGB") {
    return "YBR_FULL_422";
  }
  if (
    target.encapsulated &&
    !target.bytePreserving &&
    (decoded === "YBR_FULL" || (lossy && decoded === "PALETTE COLOR"))
  ) {
    throw new Error(
      `PhotometricInterpretation ${photometric} cannot be written as ` +
        `${target.name}; transcode to explicit-le, rle or deflate instead`
    );
  }
  return decoded;
}

/**
 * Sets TransferSyntaxUID, PhotometricInterpretation and PlanarConfiguration
 * for the new pixel data. With `lossyRatio`, records the lossy step
 * (0028,2110/2112/2114) after any earlier ones, as PS3.3 C.7.6.1.1.5 asks.
 */
export function updatePixelHeader({
  meta,
  dict,
  sourceUid,
  target,
  photometric,
  lossyRatio,
}) {
  set(meta, "00020010", "UI", target.uid);
  if (photometric) {
    set(dict, "00280004", "CS", photometric);
  }
  if (
    !isBitstreamTranscode(sourceUid, target.uid) &&
    (first(dict, "00280002") ?? 1) > 1
  ) {
    set(dict, "00280006", "US", 0);
  }
  if (lossyRatio !== undefined) {
    const ratios = dict["00282112"]?.Value ?? [];
    const methods = dict["00282114"]?.Value ?? [];
    set(dict, "00282110", "CS", "01");
    set(dict, "00282112", "DS", ...ratios, Number(lossyRatio.toFixed(2)));
    set(dict, "00282114", "CS", ...methods, target.method);
  }
}

/** Gives the instance a new SOP Instance UID, in the dataset and the meta. */
export function renewSopInstanceUid({ dcmjs, meta, dict }) {
  const uid = dcmjs.data.DicomMetaDictionary.uid();
  set(dict, "00080018", "UI", uid);
  set(meta, "00020003", "UI", uid);
  return uid;
}
