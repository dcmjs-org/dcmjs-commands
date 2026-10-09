// src/pixel/codec.js
//
// Frame-level decode/encode over @cornerstonejs/dicom-codec. The codec
// package is loaded on first use, so the other commands never pay for its
// WASM modules.

import { createRequire } from "node:module";
import {
  EXPLICIT_LITTLE_ENDIAN,
  JPEG_BASELINE,
  JPEG_XL,
  JPEG_XL_JPEG_RECOMPRESSION,
  JPEG_XL_LOSSLESS,
} from "./transferSyntaxes.js";

let dicomCodec;

function codec() {
  if (!dicomCodec) {
    dicomCodec = createRequire(import.meta.url)("@cornerstonejs/dicom-codec");
  }
  return dicomCodec;
}

const first = (dict, tag) => dict[tag]?.Value?.[0];

/** The dicom-codec imageInfo of a tag-keyed dataset. */
export function imageInfoFromDict(dict) {
  const pixelRepresentation = first(dict, "00280103") ?? 0;
  return {
    rows: first(dict, "00280010"),
    columns: first(dict, "00280011"),
    bitsAllocated: first(dict, "00280100"),
    samplesPerPixel: first(dict, "00280002") ?? 1,
    planarConfiguration: first(dict, "00280006") ?? 0,
    pixelRepresentation,
    signed: pixelRepresentation === 1,
  };
}

/** Bytes in one native frame; 1-bit packed frames are refused. */
export function nativeFrameBytes(imageInfo) {
  if (imageInfo.bitsAllocated === 1) {
    throw new Error("1-bit native pixel data is not supported");
  }
  return (
    imageInfo.rows *
    imageInfo.columns *
    imageInfo.samplesPerPixel *
    Math.ceil(imageInfo.bitsAllocated / 8)
  );
}

export function hasDecoder(transferSyntaxUID) {
  return codec().hasCodec(transferSyntaxUID);
}

/** Decodes one frame to interleaved samples. */
export async function decodeFrame(frame, imageInfo, transferSyntaxUID) {
  const { imageFrame } = await codec().decode(
    frame,
    imageInfo,
    transferSyntaxUID
  );
  return new Uint8Array(
    imageFrame.buffer,
    imageFrame.byteOffset,
    imageFrame.byteLength
  );
}

/**
 * Encodes interleaved samples to `targetUid`.
 *
 * @param {object} options `quality` (JPEG, 1..100), `distance` (JPEG XL,
 *   0..25), `lossless` (JPEG XL .112), `effort` (1..9), `progressive`.
 */
export async function encodeFrame(pixels, imageInfo, targetUid, options = {}) {
  if (targetUid === EXPLICIT_LITTLE_ENDIAN) {
    return pixels;
  }
  const encodeOptions = jxlOptions(targetUid, options);
  if (targetUid === JPEG_BASELINE) {
    encodeOptions.beforeEncode = (encoder) =>
      encoder.setQuality(options.quality ?? 90);
  }
  const { imageFrame } = await codec().encode(
    pixels,
    imageInfo,
    targetUid,
    encodeOptions
  );
  return new Uint8Array(
    imageFrame.buffer,
    imageFrame.byteOffset,
    imageFrame.byteLength
  );
}

function jxlOptions(targetUid, { distance, lossless, effort, progressive }) {
  if (targetUid === JPEG_XL) {
    return lossless
      ? { lossless: true, effort, progressive }
      : { lossless: false, distance, effort, progressive };
  }
  if (targetUid === JPEG_XL_LOSSLESS) {
    return { effort, progressive };
  }
  if (targetUid === JPEG_XL_JPEG_RECOMPRESSION) {
    return { effort };
  }
  return {};
}

/** True when the frame bitstream itself converts, without a pixel decode. */
export function isBitstreamTranscode(sourceUid, targetUid) {
  return (
    (sourceUid === JPEG_BASELINE && targetUid === JPEG_XL_JPEG_RECOMPRESSION) ||
    (sourceUid === JPEG_XL_JPEG_RECOMPRESSION && targetUid === JPEG_BASELINE)
  );
}

/** Converts one frame from `sourceUid` to `targetUid`. */
export async function transcodeFrame(
  frame,
  imageInfo,
  sourceUid,
  targetUid,
  options = {}
) {
  if (isBitstreamTranscode(sourceUid, targetUid)) {
    const { imageFrame } = await codec().transcode(
      frame,
      imageInfo,
      sourceUid,
      targetUid,
      jxlOptions(targetUid, options)
    );
    return new Uint8Array(
      imageFrame.buffer,
      imageFrame.byteOffset,
      imageFrame.byteLength
    );
  }
  const pixels = await decodeFrame(frame, imageInfo, sourceUid);
  return encodeFrame(
    pixels,
    { ...imageInfo, planarConfiguration: 0 },
    targetUid,
    options
  );
}
