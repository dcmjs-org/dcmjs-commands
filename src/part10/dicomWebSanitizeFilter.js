// src/part10/dicomWebSanitizeFilter.js
//
// Event-stream filter for DicomWebJsonWriter that enforces the
// Static-DICOMweb metadata constraints while the standard writer does
// the DICOM JSON work (one conversion implementation, not three):
//
//   - PixelData never reaches the JSON as bytes — it becomes the
//     "instances/<sop>/frames" BulkDataURI the destination's own rewrite
//     would produce, and the fragment count lands in frameInfo.
//   - Other binary values (LUTs, ICC profiles, ...) become the exact
//     hashed series-relative bulkdata URI the destination stores them
//     under, with the bytes collected into bulkdataMap keyed by URI.
//   - Underscore-prefixed bookkeeping keys are dropped at every level.
//
// The replacement events go straight to the listener base (the
// established synthesis pattern, see filters/fhirPatient.js), so this
// filter must be the last one on the writer — in practice it is the
// only one.

import { createHash } from "node:crypto";
import { bulkdataUriFor } from "../utils/getBulkdataInfo.js";

const PIXEL_DATA = "7FE00010";

function toUint8(chunk) {
  if (chunk instanceof Uint8Array) {
    return chunk;
  }
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return new Uint8Array(chunk);
}

function concatToArrayBuffer(fragments) {
  const parts = fragments.map(toUint8);
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged.buffer;
}

/**
 * @param {Object} args
 * @param {string} args.sopUID - for the frames BulkDataURI
 * @param {Map<string, ArrayBuffer>} args.bulkdataMap - URI → bytes out
 * @param {{valueCount: number}} args.frameInfo - fragment count out
 */
export function makeDicomWebSanitizeFilter({ sopUID, bulkdataMap, frameInfo }) {
  let mode = null; // null | "pixel" | "bulk" | "dropped"
  let fragments = null;
  return {
    startElement(next, tag, info) {
      if (tag.startsWith("_")) {
        mode = "dropped";
        return;
      }
      if (tag.toUpperCase() === PIXEL_DATA) {
        mode = "pixel";
        frameInfo.valueCount = 0;
        return next(tag, { ...info, vr: info?.vr || "OB" });
      }
      mode = null;
      return next(tag, info);
    },
    endElement(next) {
      const wasDropped = mode === "dropped";
      mode = null;
      return wasDropped ? undefined : next();
    },
    value(next, v, opts) {
      if (mode === "dropped") {
        return;
      }
      return next(v, opts);
    },
    bulkDataReference(next, ref) {
      if (mode === "dropped") {
        return;
      }
      return next(ref);
    },
    startBinary() {
      if (mode === "dropped" || mode === "pixel") {
        return; // swallowed; replaced at endBinary
      }
      mode = "bulk";
      fragments = [];
    },
    binaryFragment(next, chunk) {
      if (mode === "dropped") {
        return;
      }
      if (mode === "pixel") {
        frameInfo.valueCount++;
        return;
      }
      if (mode === "bulk") {
        fragments.push(chunk);
        return;
      }
      return next(chunk);
    },
    endBinary() {
      if (mode === "dropped") {
        return;
      }
      if (mode === "pixel") {
        this._baseBulkDataReference({ uri: `instances/${sopUID}/frames` });
        return;
      }
      if (mode === "bulk") {
        const buffer = concatToArrayBuffer(fragments);
        fragments = null;
        mode = null;
        const hashCode = createHash("sha256")
          .update(new Uint8Array(buffer))
          .digest("hex");
        const uri = bulkdataUriFor(hashCode);
        bulkdataMap.set(uri, buffer);
        this._baseBulkDataReference({ uri });
      }
    },
  };
}
