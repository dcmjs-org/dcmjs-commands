// src/part10/part10ToDicomWebJson.js
//
// Pure converters behind the Part 10 directory source: turn a parsed
// DicomDict into the shapes the Static-DICOMweb destination consumes.
//
// The one non-obvious constraint (verified in StaticDicomWebSeries.
// storeCurrentLevel): the destination writes metadata.gz from the SOURCE
// instance's jsonData verbatim. So jsonData must carry no ArrayBuffers
// (they would JSON.stringify to {}), PixelData must already be the
// "instances/<sop>/frames" BulkDataURI the destination's own rewrite
// produces, and other binary values must carry the exact hashed bulkdata
// path the destination will store them under (same SHA-1, computed here
// with the same getBulkdataInfo helper).

import dcmjs from "../dcmjsBundle.js";
import { naturalize } from "../utils/naturalize.js";
import { getBulkdataInfo } from "../utils/getBulkdataInfo.js";

const { unencapsulatedTransferSyntaxes, videoTransferSyntaxUIDs } =
  dcmjs.constants;

const PIXEL_DATA = "7FE00010";

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

function isBinaryValue(value) {
  return isArrayBufferLike(value) || ArrayBuffer.isView(value);
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
 * Sanitize one dict level into JSON-safe DICOM JSON: underscore-prefixed
 * bookkeeping dropped, SQ recursed, PixelData replaced by the frames
 * BulkDataURI, other binary values replaced by hashed bulkdata URIs whose
 * bytes are collected into bulkdataMap (keyed by URI).
 */
async function sanitizeLevel(dict, sopUID, bulkdataMap, frameInfo) {
  const json = {};
  for (const [key, entry] of Object.entries(dict)) {
    if (key.startsWith("_") || !entry || typeof entry !== "object") {
      continue;
    }

    if (key.toUpperCase() === PIXEL_DATA) {
      frameInfo.valueCount = Array.isArray(entry.Value)
        ? entry.Value.length
        : 0;
      json[PIXEL_DATA] = {
        vr: entry.vr || "OB",
        BulkDataURI: `instances/${sopUID}/frames`,
      };
      continue;
    }

    if (entry.vr === "SQ" && Array.isArray(entry.Value)) {
      const items = [];
      for (const item of entry.Value) {
        items.push(await sanitizeLevel(item, sopUID, bulkdataMap, frameInfo));
      }
      json[key] = { vr: "SQ", Value: items };
      continue;
    }

    const values = Array.isArray(entry.Value) ? entry.Value : [];
    if (values.some(isBinaryValue)) {
      // Non-pixel binary (LUTs, ICC profiles, ...): pre-compute the exact
      // series-relative hashed path the destination will store it under.
      const buffer = toExactArrayBuffer(values[0]);
      const { hashCode, extension } = await getBulkdataInfo(key, entry, buffer);
      const bulkDataURI =
        `../../bulkdata/${hashCode.substring(0, 3)}/` +
        `${hashCode.substring(3, 6)}/${hashCode}.${extension}`;
      bulkdataMap.set(bulkDataURI, buffer);
      json[key] = { vr: entry.vr, BulkDataURI: bulkDataURI };
      continue;
    }

    json[key] = {
      vr: entry.vr,
      ...(entry.BulkDataURI
        ? { BulkDataURI: entry.BulkDataURI }
        : { Value: structuredClone(values) }),
    };
  }
  return json;
}

/**
 * Convert one parsed Part 10 file into a source-instance entry.
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
  const jsonData = await sanitizeLevel(
    dicomDict.dict,
    sopUID,
    bulkdataMap,
    frameInfo
  );

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
  const frameSize =
    bits === 1
      ? Math.ceil((rows * columns * samples) / 8)
      : rows * columns * samples * (bits / 8);

  const needed = frameSize * numberOfFrames;
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
  return buffer.slice((frame - 1) * frameSize, frame * frameSize);
}
