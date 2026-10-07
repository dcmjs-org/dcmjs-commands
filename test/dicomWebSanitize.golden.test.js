// test/dicomWebSanitize.golden.test.js
//
// The golden gate for replacing the hand-rolled sanitizeLevel with the
// event-stream DicomWebJsonWriter + dicomWebSanitizeFilter: the metadata
// JSON produced for real files must be identical to what the previous
// implementation produced (modulo spec-legal DS/IS numeric form, PS3.18
// F.2.3.1 — any such difference is asserted explicitly, not ignored).
// The reference implementation below IS the previous sanitizeLevel,
// copied verbatim (SHA-256, matching the current hashing).

import fs from "fs";
import path from "path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { part10ToEntry } from "../src/part10/part10ToDicomWebJson.js";

const require = createRequire(import.meta.url);
const dcmjs = require("dcmjs");
dcmjs.log.setLevel("silent");

const { DicomMessage } = dcmjs.data;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "sample-dicom.dcm");

const PIXEL_DATA = "7FE00010";

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

/** The previous implementation, verbatim (hash updated to SHA-256). */
async function referenceSanitizeLevel(dict, sopUID, bulkdataMap, frameInfo) {
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
        items.push(
          await referenceSanitizeLevel(item, sopUID, bulkdataMap, frameInfo)
        );
      }
      json[key] = { vr: "SQ", Value: items };
      continue;
    }
    const values = Array.isArray(entry.Value) ? entry.Value : [];
    if (values.some(isBinaryValue)) {
      const buffer = toExactArrayBuffer(values[0]);
      const hashCode = createHash("sha256")
        .update(new Uint8Array(buffer))
        .digest("hex");
      const bulkDataURI =
        `../../bulkdata/${hashCode.substring(0, 3)}/` +
        `${hashCode.substring(3, 6)}/${hashCode}.mht`;
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

function readDicomDict(filePath) {
  const buf = fs.readFileSync(filePath);
  return DicomMessage.readFile(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  );
}

test("event-stream sanitize matches the previous implementation on the fixture", async () => {
  const dicomDict = readDicomDict(FIXTURE);
  const refMap = new Map();
  const refFrames = { valueCount: 0 };
  const reference = await referenceSanitizeLevel(
    dicomDict.dict,
    dicomDict.dict["00080018"].Value[0],
    refMap,
    refFrames
  );

  const entry = await part10ToEntry(readDicomDict(FIXTURE), FIXTURE);
  expect(entry).not.toBeNull();

  // Metadata: identical JSON, via the serialized form so undefined-vs-
  // absent keys and value coercions cannot hide.
  expect(JSON.parse(JSON.stringify(entry.jsonData))).toEqual(
    JSON.parse(JSON.stringify(reference))
  );

  // Bulkdata: same URIs, same bytes.
  expect([...entry.bulkdataMap.keys()].sort()).toEqual(
    [...refMap.keys()].sort()
  );
  for (const [uri, bytes] of refMap) {
    expect(
      Buffer.from(entry.bulkdataMap.get(uri)).equals(Buffer.from(bytes))
    ).toBe(true);
  }

  // Frame bookkeeping unchanged.
  expect(entry.frameInfo.valueCount).toBe(refFrames.valueCount);
});
