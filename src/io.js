// src/io.mjs
//
// Shared file/byte helpers for the dcmjs CLI. Pure functions plus thin fs
// wrappers; commands stay testable by injecting stdout/stderr and asserting
// on return values.

import fs from "node:fs";
import path from "node:path";

/**
 * Node Buffer (possibly a view into the shared read pool) → exact
 * ArrayBuffer. Never use a bare `.buffer` — pooled reads would hand the
 * parser unrelated bytes before/after the file content.
 */
export function toArrayBuffer(buffer) {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
}

/** Read a file as an exact ArrayBuffer. */
export function readFileArrayBuffer(filePath) {
  return toArrayBuffer(fs.readFileSync(filePath));
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * Sniff what a file is: "dicom" (DICM magic at offset 128), "pdf"
 * (%PDF- at offset 0), "png", "jpeg", "mp4" (ftyp box at offset 4), or
 * "unknown". Extension is the tiebreaker when the magic checks cannot be
 * read (short files). DICM is checked first — a Part 10 file can contain
 * JPEG or MP4 bytes in its fragments, but never before the 132-byte
 * preamble.
 */
export function sniffKind(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const dicm = Buffer.alloc(4);
    if (
      fs.readSync(fd, dicm, 0, 4, 128) === 4 &&
      dicm.toString("ascii") === "DICM"
    ) {
      return "dicom";
    }
    const head = Buffer.alloc(8);
    const headBytes = fs.readSync(fd, head, 0, 8, 0);
    if (headBytes >= 5 && head.toString("ascii", 0, 5) === "%PDF-") {
      return "pdf";
    }
    if (headBytes >= 8 && head.equals(PNG_MAGIC)) {
      return "png";
    }
    if (headBytes >= 3 && head.subarray(0, 3).equals(JPEG_MAGIC)) {
      return "jpeg";
    }
    if (headBytes >= 8 && head.toString("ascii", 4, 8) === "ftyp") {
      return "mp4";
    }
  } catch {
    // fall through to extension check
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
  if (/\.(dcm|dicom|lei)$/i.test(filePath)) {
    return "dicom";
  }
  if (/\.pdf$/i.test(filePath)) {
    return "pdf";
  }
  if (/\.png$/i.test(filePath)) {
    return "png";
  }
  if (/\.(jpg|jpeg)$/i.test(filePath)) {
    return "jpeg";
  }
  if (/\.(mp4|m4v)$/i.test(filePath)) {
    return "mp4";
  }
  return "unknown";
}

/**
 * JSON.stringify replacer that makes binary values visible.
 * JSON.stringify(ArrayBuffer) silently yields {} — never acceptable output.
 * mode "base64": inline base64 strings (machine-readable output).
 * mode "summary": "[binary N bytes]" placeholders (human-readable dump).
 */
export function binaryReplacer(mode) {
  return function (key, value) {
    // (7FE0,0003) Encapsulated Pixel Data Value Total Length is a uint64 and
    // naturalizes to a BigInt, which JSON.stringify rejects outright.
    if (typeof value === "bigint") {
      return value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : value.toString();
    }
    let bytes = null;
    if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value);
    } else if (ArrayBuffer.isView(value)) {
      bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (bytes === null) {
      return value;
    }
    if (mode === "base64") {
      return Buffer.from(bytes).toString("base64");
    }
    return `[binary ${bytes.byteLength} bytes]`;
  };
}

/**
 * Deliver command output. Strings go to the output file or stdout; binary
 * (Buffer/Uint8Array) REQUIRES an output path — never binary to stdout.
 * @returns {string|null} the path written, or null when printed
 */
export function writeOutput({ output, data, stdout }) {
  const isBinary = Buffer.isBuffer(data) || ArrayBuffer.isView(data);
  if (isBinary) {
    if (!output) {
      throw new Error(
        "refusing to write binary output to stdout; use -o <file>"
      );
    }
    fs.writeFileSync(output, data);
    return output;
  }
  if (output) {
    fs.writeFileSync(output, data);
    return output;
  }
  stdout(data);
  return null;
}

/**
 * A Static-DICOMweb tree announces itself with a studies/ subdirectory.
 */
export function looksLikeStaticDicomWeb(dir) {
  try {
    return fs.statSync(path.join(dir, "studies")).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A Part 10 directory is any directory containing at least one file with
 * the DICM magic (extensionless CD layouts included). The walk is bounded —
 * this is a sniff, not an inventory.
 */
export function looksLikePart10Directory(dir, budget = { entries: 200 }) {
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    return false;
  }
  if (!stat.isDirectory()) {
    return false;
  }
  for (const entry of fs.readdirSync(dir).sort()) {
    if (budget.entries-- <= 0) {
      return false;
    }
    if (entry === "node_modules" || entry.startsWith(".")) {
      continue;
    }
    const entryPath = path.join(dir, entry);
    const entryStat = fs.statSync(entryPath);
    if (entryStat.isDirectory()) {
      if (looksLikePart10Directory(entryPath, budget)) {
        return true;
      }
    } else if (entryStat.isFile() && sniffKind(entryPath) === "dicom") {
      return true;
    }
  }
  return false;
}

/**
 * Recursively collect DICOM files from files/directories.
 * Slim sibling of the discovery in scripts/corpus-runner.mjs (kept
 * self-contained there on purpose — see its header).
 */
export function discoverDicomFiles(target, found = []) {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target).sort()) {
      if (entry === "node_modules" || entry.startsWith(".")) {
        continue;
      }
      discoverDicomFiles(path.join(target, entry), found);
    }
  } else if (stat.isFile() && sniffKind(target) === "dicom") {
    found.push(target);
  }
  return found;
}
