// src/part10/part10ToDicomWebJson.js
//
// Pure converters behind the Part 10 directory source: turn a parsed
// DicomDict into the shapes the Static-DICOMweb destination consumes.
// The DICOM JSON itself comes from the standard event-stream pair
// (fromDataSet → DicomWebJsonWriter); dicomWebSanitizeFilter enforces
// the Static-DICOMweb constraints on the way through.

import dcmjs from "../dcmjsBundle.js";
import { naturalize } from "../utils/naturalize.js";
import { makeDicomWebSanitizeFilter } from "./dicomWebSanitizeFilter.js";

const { unencapsulatedTransferSyntaxes, videoTransferSyntaxUIDs } =
  dcmjs.constants;

const TRANSFER_SYNTAX_CONTENT_TYPES = {
  "1.2.840.10008.1.2.4.50": "image/jpeg",
  "1.2.840.10008.1.2.4.51": "image/jpeg",
  "1.2.840.10008.1.2.4.57": "image/jpeg",
  "1.2.840.10008.1.2.4.70": "image/jpeg",
  "1.2.840.10008.1.2.4.80": "image/x-jls",
  "1.2.840.10008.1.2.4.81": "image/x-jls",
  "1.2.840.10008.1.2.4.90": "image/jp2",
  "1.2.840.10008.1.2.4.91": "image/jp2",
  "1.2.840.10008.1.2.4.201": "image/jphc",
  "1.2.840.10008.1.2.4.202": "image/jphc",
  "1.2.840.10008.1.2.4.203": "image/jphc",
};

export function contentTypeForTransferSyntax(transferSyntaxUID) {
  return (
    TRANSFER_SYNTAX_CONTENT_TYPES[transferSyntaxUID] ||
    "application/octet-stream"
  );
}

/** Realm-safe ArrayBuffer check (jest VM modules cross realms). */
function isArrayBufferLike(value) {
  return (
    value instanceof ArrayBuffer ||
    Object.prototype.toString.call(value) === "[object ArrayBuffer]"
  );
}

function toExactArrayBuffer(value) {
  if (isArrayBufferLike(value)) {
    return value;
  }
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength
  );
}

/**
 * Convert one parsed Part 10 file into a source-instance entry.
 *
 * The non-obvious constraint this function owns (verified in
 * StaticDicomWebSeries.storeCurrentLevel): the destination writes
 * metadata.gz from the returned jsonData VERBATIM. So jsonData must
 * carry no ArrayBuffers (they would JSON.stringify to {}), PixelData
 * must already be the "instances/<sop>/frames" BulkDataURI the
 * destination's own rewrite produces, and every other binary value must
 * carry the exact hashed bulkdata path the destination will store it
 * under (same SHA-256 the Static-DICOMweb tools use). The sanitize
 * filter on the DicomWebJsonWriter enforces all three.
 *
 * @param {Object} dicomDict - DicomMessage.readFile result ({ meta, dict })
 * @param {string} filePath - origin, for re-reads and error messages
 * @returns {Promise<Object|null>} entry { filePath, sopUID, seriesUID,
 *   studyUID, transferSyntaxUID, jsonData, natural, bulkdataMap,
 *   frameInfo } — or null when required UIDs are missing
 */
export async function part10ToEntry(dicomDict, filePath) {
  const uidOf = (tag) => dicomDict.dict[tag]?.Value?.[0];
  const sopUID = uidOf("00080018");
  const seriesUID = uidOf("0020000E");
  const studyUID = uidOf("0020000D");
  if (!sopUID || !seriesUID || !studyUID) {
    return null;
  }

  const transferSyntaxUID =
    dicomDict.meta?.["00020010"]?.Value?.[0] || "1.2.840.10008.1.2.1";

  const bulkdataMap = new Map();
  const frameInfo = {
    valueCount: 0,
    encapsulated: !unencapsulatedTransferSyntaxes[transferSyntaxUID],
    video: videoTransferSyntaxUIDs.has(transferSyntaxUID),
  };
  const { DicomEventStream, DicomWebJsonWriter } = dcmjs.eventStream;
  const writer = new DicomWebJsonWriter(
    makeDicomWebSanitizeFilter({ sopUID, bulkdataMap, frameInfo })
  );
  // dict only — meta would be written flat alongside the dataset, and
  // metadata.gz carries the dataset alone.
  await DicomEventStream.fromDataSet({ dict: dicomDict.dict }).process(writer);
  const jsonData = writer.result;

  // Naturalize the SANITIZED json (never the raw dict): natural objects
  // end up stringified into the series-natural query file.
  const natural = naturalize(structuredClone(jsonData));

  return {
    filePath,
    sopUID,
    seriesUID,
    studyUID,
    transferSyntaxUID,
    jsonData,
    natural,
    bulkdataMap,
    frameInfo,
  };
}

/**
 * Extract one frame's bytes from a PixelData Value array.
 *
 * @param {Array} pixelValue - dict["7FE00010"].Value from a fresh parse
 * @param {number} frame - 1-based frame number
 * @param {Object} entry - the source entry (frameInfo, natural, filePath)
 * @returns {ArrayBuffer}
 */
export function extractFrame(pixelValue, frame, entry) {
  const { natural, frameInfo, filePath } = entry;
  const numberOfFrames = Number(natural.NumberOfFrames) || 1;

  if (!Array.isArray(pixelValue) || pixelValue.length === 0) {
    throw new Error(`no PixelData in ${filePath}`);
  }

  if (frameInfo.encapsulated) {
    if (pixelValue.length === numberOfFrames) {
      return toExactArrayBuffer(pixelValue[frame - 1]);
    }
    if (numberOfFrames === 1 || frameInfo.video) {
      // All fragments are one frame (or one video stream): concatenate.
      const total = pixelValue.reduce((sum, f) => sum + f.byteLength, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const fragment of pixelValue) {
        merged.set(
          isArrayBufferLike(fragment)
            ? new Uint8Array(fragment)
            : new Uint8Array(
                fragment.buffer,
                fragment.byteOffset,
                fragment.byteLength
              ),
          offset
        );
        offset += fragment.byteLength;
      }
      return merged.buffer;
    }
    throw new Error(
      `cannot split ${pixelValue.length} pixel-data fragments into ` +
        `${numberOfFrames} frames (no usable Basic Offset Table) in ${filePath}`
    );
  }

  // Native: a single buffer holding all frames, sliced by computed size.
  const buffer = toExactArrayBuffer(pixelValue[0]);
  const bits = Number(natural.BitsAllocated) || 8;
  const samples = Number(natural.SamplesPerPixel) || 1;
  const rows = Number(natural.Rows);
  const columns = Number(natural.Columns);
  const frameBits = rows * columns * samples * bits;
  const needed = Math.ceil((frameBits * numberOfFrames) / 8);
  // tolerate the writer's single trailing pad byte
  if (!(buffer.byteLength === needed || buffer.byteLength === needed + 1)) {
    if (buffer.byteLength < needed) {
      throw new Error(
        `PixelData in ${filePath} is ${buffer.byteLength} bytes but ` +
          `${numberOfFrames} frame(s) of ${rows}x${columns}x${samples} at ` +
          `${bits} bits need ${needed} — file is truncated or the geometry is wrong`
      );
    }
  }
  if (frameBits % 8 === 0) {
    const frameSize = frameBits / 8;
    return buffer.slice((frame - 1) * frameSize, frame * frameSize);
  }
  return extractBitPackedFrame(buffer, (frame - 1) * frameBits, frameBits);
}

/**
 * Copy one frame of bit-packed (BitsAllocated 1) pixel data into its own
 * buffer. DICOM packs 1-bit frames with no padding between frames, so a
 * frame whose bit count is not a multiple of 8 starts inside a byte. Bits
 * are little-endian within each byte (pixel 0 is bit 0); the last output
 * byte is zero-padded.
 *
 * @param {ArrayBuffer} buffer - all frames
 * @param {number} startBit - bit offset of the frame in buffer
 * @param {number} frameBits - bits in one frame
 * @returns {ArrayBuffer}
 */
export function extractBitPackedFrame(buffer, startBit, frameBits) {
  const source = new Uint8Array(buffer);
  const out = new Uint8Array(Math.ceil(frameBits / 8));
  const shift = startBit % 8;
  const first = startBit >> 3;
  for (let i = 0; i < out.length; i++) {
    const low = source[first + i] >> shift;
    const high = shift ? (source[first + i + 1] ?? 0) << (8 - shift) : 0;
    out[i] = (low | high) & 0xff;
  }
  const tailBits = frameBits % 8;
  if (tailBits) {
    out[out.length - 1] &= (1 << tailBits) - 1;
  }
  return out.buffer;
}
