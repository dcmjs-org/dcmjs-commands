// src/dimse/Part10FileDataset.js
//
// A dcmjs-dimse Dataset that sends the bytes of a Part 10 file unchanged.

import fs from "node:fs";
import dimse from "dcmjs-dimse";
import dcmjs from "../dcmjsBundle.js";
import { toArrayBuffer } from "../io.js";

const { Dataset } = dimse;
const { DicomMessage, DicomMetaDictionary } = dcmjs.data;

// 128-byte preamble + "DICM" + (0002,0000) UL header (8 bytes) + value (4 bytes)
const GROUP_LENGTH_END = 144;
// The SOP UIDs are near the start of the dataset; a larger header reads the whole file
const HEADER_READ_BYTES = 64 * 1024;

/** Reads the first `length` bytes of a file. */
function readStart(path, length) {
  const fd = fs.openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    return buffer.subarray(0, fs.readSync(fd, buffer, 0, length, 0));
  } finally {
    fs.closeSync(fd);
  }
}

/** Decodes the meta group and the dataset up to (0008,0018), or undefined. */
function decodeHeader(bytes) {
  try {
    const result = DicomMessage.readFile(toArrayBuffer(bytes), {
      untilTag: "00080019",
    });
    return result.dict["00080018"] ? result : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the File Meta Information and the SOP UIDs of a Part 10 file. The
 * decode reads the first 64 KiB of the file, and reads the whole file only
 * when (0008,0018) SOPInstanceUID is not in that part.
 * @param {string} path - Part 10 file path.
 * @returns {{meta: Object, sopClassUid: string, sopInstanceUid: string,
 *   bodyOffset: number}} The naturalized meta group, the SOP UIDs of the
 *   dataset, and the byte offset of the first dataset element.
 * @throws {Error} When the file has no DICM marker.
 */
export function readPart10Header(path) {
  let bytes = readStart(path, HEADER_READ_BYTES);
  if (bytes.toString("latin1", 128, 132) !== "DICM") {
    throw new Error("not a Part 10 file (no DICM marker)");
  }
  let decoded = decodeHeader(bytes);
  if (!decoded && bytes.length === HEADER_READ_BYTES) {
    bytes = fs.readFileSync(path);
    decoded = decodeHeader(bytes);
  }
  const { meta, dict } =
    decoded ||
    DicomMessage.readFile(toArrayBuffer(bytes), { untilTag: "00080019" });
  const naturalMeta = DicomMetaDictionary.naturalizeDataset(meta);
  return {
    meta: naturalMeta,
    sopClassUid:
      dict["00080016"]?.Value?.[0] ?? naturalMeta.MediaStorageSOPClassUID,
    sopInstanceUid:
      dict["00080018"]?.Value?.[0] ?? naturalMeta.MediaStorageSOPInstanceUID,
    bodyOffset: GROUP_LENGTH_END + bytes.readUInt32LE(140),
  };
}

/**
 * A Dataset for a C-STORE request that reads its Part 10 file only when
 * dcmjs-dimse sends it.
 *
 * When the accepted transfer syntax equals the file's transfer syntax,
 * dcmjs-dimse sends `getDenaturalizedDataset()`: the file body, unchanged.
 * When the syntaxes differ, dcmjs-dimse transcodes from `getElements()`,
 * and this class then decodes the whole file with dcmjs-dimse.
 */
export class Part10FileDataset extends Dataset {
  /** @param {string} path - Part 10 file path. */
  constructor(path) {
    const { meta, sopClassUid, sopInstanceUid, bodyOffset } =
      readPart10Header(path);
    super({}, meta.TransferSyntaxUID);
    this.path = path;
    this.bodyOffset = bodyOffset;
    this.sopClassUid = sopClassUid;
    this.sopInstanceUid = sopInstanceUid;
    this.decoded = undefined;
  }

  getElement(tag) {
    if (tag === "SOPClassUID") return this.sopClassUid;
    if (tag === "SOPInstanceUID") return this.sopInstanceUid;
    return this.getElements()[tag];
  }

  getElements() {
    this.decoded ||= Dataset.fromFile(this.path);
    return this.decoded.getElements();
  }

  getDenaturalizedDataset() {
    // shortcut: the whole file is in memory while it is sent; stream it in
    // PDV-sized reads when dcmjs-dimse accepts a stream for a C-STORE
    return fs.readFileSync(this.path).subarray(this.bodyOffset);
  }

  toString() {
    return `Part 10 file: ${this.path}`;
  }
}
