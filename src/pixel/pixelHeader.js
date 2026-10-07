// src/pixel/pixelHeader.js
//
// Header updates for re-encoded pixel data, shared by `transcode` and
// `wsiresize`. Datasets are tag-keyed `{ vr, Value }` dicts.

import { isBitstreamTranscode } from "./codec.js";

/** Decoders hand these back as RGB; the others come back unchanged. */
const DECODED_AS_RGB = new Set([
  "YBR_FULL_422",
  "YBR_PARTIAL_420",
  "YBR_ICT",
  "YBR_RCT",
]);

const set = (dict, tag, vr, ...Value) => {
  dict[tag] = { vr, Value };
};
const first = (dict, tag) => dict[tag]?.Value?.[0];

/**
 * The PhotometricInterpretation after `source` → `target`, or throws for a
 * colour model that the target codec would misread.
 */
export function photometricAfter({ photometric, sourceUid, target }) {
  if (isBitstreamTranscode(sourceUid, target.uid)) {
    return photometric;
  }
  const decoded = DECODED_AS_RGB.has(photometric) ? "RGB" : photometric;
  if (target.uid === "1.2.840.10008.1.2.4.50" && decoded === "RGB") {
    return "YBR_FULL_422";
  }
  if (
    target.encapsulated &&
    (decoded === "YBR_FULL" || (target.lossy && decoded === "PALETTE COLOR"))
  ) {
    throw new Error(
      `PhotometricInterpretation ${photometric} cannot be written as ` +
        `${target.name}; transcode to explicit-le or jxl-lossless instead`
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
