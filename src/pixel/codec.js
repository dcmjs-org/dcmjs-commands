// src/pixel/codec.js
//
// Frame-level decode/encode over @cornerstonejs/dicom-codec. The codec
// package is loaded on first use, so the other commands never pay for its
// WASM modules.

import { createRequire } from "node:module";
import zlib from "node:zlib";
import {
  DEFLATED_IMAGE_FRAME,
  EXPLICIT_LITTLE_ENDIAN,
  JPEG_BASELINE,
  JPEG_XL,
  JPEG_XL_JPEG_RECOMPRESSION,
  JPEG_XL_LOSSLESS,
  RLE_LOSSLESS,
  isNativeSyntax,
} from "./transferSyntaxes.js";
import { encodeRleFrame } from "./rle.js";

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

/**
 * Bytes in one native frame. A 1-bit frame is its packed bytes; native 1-bit
 * frames are packed back to back, so one that does not end on a byte
 * boundary is refused.
 */
export function nativeFrameBytes(imageInfo) {
  if (imageInfo.bitsAllocated === 1) {
    const bits = imageInfo.rows * imageInfo.columns * imageInfo.samplesPerPixel;
    if (bits % 8) {
      throw new Error(
        "1-bit frames that do not end on a byte boundary are not supported"
      );
    }
    return bits / 8;
  }
  return (
    imageInfo.rows *
    imageInfo.columns *
    imageInfo.samplesPerPixel *
    Math.ceil(imageInfo.bitsAllocated / 8)
  );
}

export function hasDecoder(transferSyntaxUID) {
  return (
    transferSyntaxUID === DEFLATED_IMAGE_FRAME ||
    codec().hasCodec(transferSyntaxUID)
  );
}

const asUint8 = (bytes) =>
  new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * Decodes one frame to interleaved samples; a 1-bit frame decodes to its
 * packed bytes.
 */
export async function decodeFrame(frame, imageInfo, transferSyntaxUID) {
  if (transferSyntaxUID === DEFLATED_IMAGE_FRAME) {
    // Inflate stops at the end of the deflate stream, before any pad byte.
    return asUint8(zlib.inflateRawSync(frame));
  }
  if (imageInfo.bitsAllocated === 1) {
    if (isNativeSyntax(transferSyntaxUID)) {
      return frame;
    }
    if (transferSyntaxUID !== RLE_LOSSLESS) {
      throw new Error(
        `1-bit pixel data in transfer syntax ${transferSyntaxUID} is not supported`
      );
    }
    // One RLE segment of packed bytes: decode it as a row of 8-bit samples.
    imageInfo = {
      rows: 1,
      columns: nativeFrameBytes(imageInfo),
      bitsAllocated: 8,
      samplesPerPixel: 1,
      pixelRepresentation: 0,
    };
  }
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
 *   0..25), `lossless` (JPEG XL .112), `effort` (JPEG XL effort or deflate
 *   level, 1..9; deflate defaults to 9), `progressive`.
 */
export async function encodeFrame(pixels, imageInfo, targetUid, options = {}) {
  if (targetUid === EXPLICIT_LITTLE_ENDIAN) {
    return pixels;
  }
  if (targetUid === RLE_LOSSLESS) {
    return encodeRleFrame(pixels, imageInfo);
  }
  if (targetUid === DEFLATED_IMAGE_FRAME) {
    return asUint8(zlib.deflateRawSync(pixels, { level: options.effort ?? 9 }));
  }
  if (imageInfo.bitsAllocated === 1) {
    throw new Error(
      "Bits Allocated 1 can be written only as explicit-le, rle or deflate " +
        "(PS3.5 CP-2301, Sup 244)"
    );
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
