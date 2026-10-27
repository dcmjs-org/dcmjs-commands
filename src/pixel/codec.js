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
  isLittleEndianNative,
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

/** True when frames are stored as plain samples (native, or deflated). */
export const hasNativeLayout = (transferSyntaxUID) =>
  isNativeSyntax(transferSyntaxUID) ||
  transferSyntaxUID === DEFLATED_IMAGE_FRAME;

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
    photometric: first(dict, "00280004"),
  };
}

/** Native YBR_FULL_422 stores two pixels in Y Y Cb Cr (PS3.3 C.7.6.3.1.2). */
const isNative422 = (imageInfo) =>
  imageInfo.photometric === "YBR_FULL_422" &&
  imageInfo.samplesPerPixel === 3 &&
  imageInfo.bitsAllocated === 8;

/**
 * Bytes in one native frame. A 1-bit frame is its packed bytes; native 1-bit
 * frames are packed back to back, so one that does not end on a byte
 * boundary is refused. YBR_FULL_422 has 2 bytes per pixel.
 */
export function nativeFrameBytes(imageInfo) {
  const { rows, columns, bitsAllocated } = imageInfo;
  if (
    ![rows, columns, bitsAllocated].every((n) => Number.isInteger(n) && n > 0)
  ) {
    throw new Error(
      "Rows, Columns and BitsAllocated must be positive whole numbers " +
        "to split native pixel data into frames"
    );
  }
  if (isNative422(imageInfo)) {
    return rows * columns * 2;
  }
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

/**
 * Bytes in one decoded frame: full-resolution samples, as `decodeFrame`
 * returns them, also for a YBR_FULL_422 source.
 */
export const decodedFrameBytes = (imageInfo) =>
  nativeFrameBytes({ ...imageInfo, photometric: undefined });

export function hasDecoder(transferSyntaxUID) {
  return (
    transferSyntaxUID === DEFLATED_IMAGE_FRAME ||
    codec().hasCodec(transferSyntaxUID)
  );
}

const asUint8 = (bytes) =>
  new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** Y Y Cb Cr pairs to one Y Cb Cr per pixel, the chroma repeated. */
function upsample422(frame, { rows, columns }) {
  const out = new Uint8Array(rows * columns * 3);
  for (let i = 0, o = 0; o < out.length; i += 4, o += 6) {
    out[o] = frame[i];
    out[o + 3] = frame[i + 1];
    out[o + 1] = out[o + 4] = frame[i + 2];
    out[o + 2] = out[o + 5] = frame[i + 3];
  }
  return out;
}

/** Plane-by-plane samples (PlanarConfiguration 1) to interleaved samples. */
function interleave(planar, { rows, columns, samplesPerPixel, bitsAllocated }) {
  const bytes = bitsAllocated / 8;
  const pixels = rows * columns;
  const plane = pixels * bytes;
  const out = new Uint8Array(plane * samplesPerPixel);
  for (let s = 0; s < samplesPerPixel; s++) {
    for (let p = 0; p < pixels; p++) {
      for (let b = 0; b < bytes; b++) {
        out[(p * samplesPerPixel + s) * bytes + b] =
          planar[s * plane + p * bytes + b];
      }
    }
  }
  return out;
}

/** Native frame bytes as full-resolution interleaved samples. */
function nativeToInterleaved(pixels, imageInfo) {
  if (isNative422(imageInfo)) {
    return upsample422(pixels, imageInfo);
  }
  if (imageInfo.samplesPerPixel > 1 && imageInfo.planarConfiguration === 1) {
    return interleave(pixels, imageInfo);
  }
  return pixels;
}

/**
 * Decodes one frame to interleaved samples; a 1-bit frame decodes to its
 * packed bytes. Native YBR_FULL_422 decodes to full-resolution YBR_FULL.
 */
export async function decodeFrame(frame, imageInfo, transferSyntaxUID) {
  if (transferSyntaxUID === DEFLATED_IMAGE_FRAME) {
    // Inflate stops at the end of the deflate stream, before any pad byte.
    return nativeToInterleaved(asUint8(zlib.inflateRawSync(frame)), imageInfo);
  }
  if (isNativeSyntax(transferSyntaxUID) && isNative422(imageInfo)) {
    return upsample422(frame, imageInfo);
  }
  // Little endian native frames are already samples; the codec would only
  // hand them back.
  if (isLittleEndianNative(transferSyntaxUID)) {
    // A 16-bit view needs an even offset, as the codec's decoder ensured.
    const aligned =
      imageInfo.bitsAllocated > 8 && frame.byteOffset % 2
        ? frame.slice()
        : frame;
    return nativeToInterleaved(aligned, imageInfo);
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
  // The RLE decoder writes plane by plane for PlanarConfiguration 1.
  const { imageFrame } = await codec().decode(
    frame,
    transferSyntaxUID === RLE_LOSSLESS
      ? { ...imageInfo, planarConfiguration: 0 }
      : imageInfo,
    transferSyntaxUID
  );
  const pixels = asUint8(imageFrame);
  return isNativeSyntax(transferSyntaxUID)
    ? nativeToInterleaved(pixels, imageInfo)
    : pixels;
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
