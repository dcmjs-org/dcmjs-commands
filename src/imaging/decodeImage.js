// src/imaging/decodeImage.js
//
// PNG/JPEG decode for `dcmjs convert` — the codec lives here in the CLI, not
// in the dcmjs library (which stays dependency-free and browser-compatible;
// its DicomEventStream.fromImage takes already-decoded pixels).
//
// Output is the decodedImage shape fromImage consumes:
//   { pixels, rows, columns, samplesPerPixel, photometricInterpretation,
//     bitsAllocated, bitsStored, highBit, pixelRepresentation }

import { PNG } from "pngjs";
import jpeg from "jpeg-js";

/** RGBA interleaved → RGB (drop alpha), preserving sample width. */
function stripAlpha(rgba, ArrayType) {
  const pixelCount = rgba.length / 4;
  const rgb = new ArrayType(pixelCount * 3);
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
    rgb[o] = rgba[i];
    rgb[o + 1] = rgba[i + 1];
    rgb[o + 2] = rgba[i + 2];
  }
  return rgb;
}

/** Interleaved RGB → single gray channel (only call when R==G==B holds). */
function collapseToGray(rgb, ArrayType) {
  const gray = new ArrayType(rgb.length / 3);
  for (let i = 0, o = 0; i < rgb.length; i += 3, o++) {
    gray[o] = rgb[i];
  }
  return gray;
}

function isUniformGray(rgb) {
  for (let i = 0; i < rgb.length; i += 3) {
    if (rgb[i] !== rgb[i + 1] || rgb[i] !== rgb[i + 2]) {
      return false;
    }
  }
  return true;
}

function decodePng(buffer) {
  const png = PNG.sync.read(Buffer.from(buffer));
  // pngjs always hands back 8-bit RGBA in png.data; 16-bit files keep their
  // depth in png.depth with data widened per channel when readable as 16.
  const sixteenBit = png.depth === 16;

  // pngjs delivers png.data as 8-bit RGBA even for 16-bit sources unless
  // read with { skipRescale: true }; re-read when depth is 16.
  if (sixteenBit) {
    const wide = PNG.sync.read(Buffer.from(buffer), { skipRescale: true });
    const rgba = new Uint16Array(
      wide.data.buffer,
      wide.data.byteOffset,
      wide.data.byteLength / 2
    );
    const rgb = stripAlpha(rgba, Uint16Array);
    const gray = isUniformGray(rgb);
    return {
      pixels: gray ? collapseToGray(rgb, Uint16Array) : rgb,
      rows: png.height,
      columns: png.width,
      samplesPerPixel: gray ? 1 : 3,
      photometricInterpretation: gray ? "MONOCHROME2" : "RGB",
      bitsAllocated: 16,
      bitsStored: 16,
      highBit: 15,
      pixelRepresentation: 0,
    };
  }

  const rgb = stripAlpha(png.data, Uint8Array);
  const gray = isUniformGray(rgb);
  return {
    pixels: gray ? collapseToGray(rgb, Uint8Array) : rgb,
    rows: png.height,
    columns: png.width,
    samplesPerPixel: gray ? 1 : 3,
    photometricInterpretation: gray ? "MONOCHROME2" : "RGB",
    bitsAllocated: 8,
    bitsStored: 8,
    highBit: 7,
    pixelRepresentation: 0,
  };
}

function decodeJpeg(buffer) {
  const decoded = jpeg.decode(Buffer.from(buffer), {
    useTArray: true,
    maxMemoryUsageInMB: 1024,
  });
  const rgb = stripAlpha(decoded.data, Uint8Array);
  const gray = isUniformGray(rgb);
  return {
    pixels: gray ? collapseToGray(rgb, Uint8Array) : rgb,
    rows: decoded.height,
    columns: decoded.width,
    samplesPerPixel: gray ? 1 : 3,
    photometricInterpretation: gray ? "MONOCHROME2" : "RGB",
    bitsAllocated: 8,
    bitsStored: 8,
    highBit: 7,
    pixelRepresentation: 0,
  };
}

/**
 * Decode an image file's bytes to the fromImage decodedImage shape.
 * Uniform-gray RGB collapses to MONOCHROME2 automatically — screenshots of
 * grayscale medical images are almost always stored as gray-in-RGB.
 *
 * @param {"png"|"jpeg"} kind - from sniffKind
 * @param {ArrayBuffer} arrayBuffer
 */
export function decodeImage(kind, arrayBuffer) {
  if (kind === "png") {
    return decodePng(arrayBuffer);
  }
  if (kind === "jpeg") {
    return decodeJpeg(arrayBuffer);
  }
  throw new Error(`decodeImage: unsupported image kind "${kind}"`);
}
