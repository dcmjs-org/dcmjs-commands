// src/pixel/frameWriter.js
//
// Writes a Part 10 file whose PixelData comes from a spool of encoded frames.
// The frames are spooled first so that the header can carry values only
// known after encoding (the lossy compression ratio, the offset table).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";

const PIXEL_DATA = "7FE00010";
const MAX_BOT_OFFSET = 0xffffffff;

/** An append-only temp file of frames, next to `nearPath`. */
export class FrameSpool {
  constructor(nearPath) {
    this.path = path.join(
      path.dirname(nearPath),
      `.${path.basename(nearPath)}.${crypto.randomBytes(4).toString("hex")}.frames`
    );
    this.out = fs.createWriteStream(this.path);
    this.lengths = [];
    this.bytes = 0;
  }

  async append(frame) {
    this.lengths.push(frame.byteLength);
    this.bytes += frame.byteLength;
    if (!this.out.write(frame)) {
      await once(this.out, "drain");
    }
  }

  async close() {
    if (!this.out.closed) {
      this.out.end();
      await once(this.out, "close");
    }
  }

  /**
   * Random access to the closed spool: `read(i)` gives frame `i`. Call
   * `close()` on the result when done.
   */
  async openReader() {
    await this.close();
    const offsets = [];
    let offset = 0;
    for (const length of this.lengths) {
      offsets.push(offset);
      offset += length;
    }
    const handle = await fs.promises.open(this.path, "r");
    return {
      read: async (i) => {
        const buffer = Buffer.alloc(this.lengths[i]);
        await handle.read(buffer, 0, buffer.length, offsets[i]);
        return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
      },
      close: () => handle.close(),
    };
  }

  async remove() {
    this.out.destroy();
    fs.rmSync(this.path, { force: true });
  }
}

function itemHeader(group, element, length) {
  const header = Buffer.alloc(8);
  header.writeUInt16LE(group, 0);
  header.writeUInt16LE(element, 2);
  header.writeUInt32LE(length >>> 0, 4);
  return header;
}

/**
 * The encapsulated PixelData element up to its first fragment: header,
 * Basic Offset Table (empty when an offset would not fit in 32 bits), and
 * the per-frame item headers are written by the caller.
 */
function encapsulatedHeader(lengths) {
  const offsets = [];
  let offset = 0;
  for (const length of lengths) {
    offsets.push(offset);
    offset += 8 + length + (length % 2);
  }
  const useBot = offsets.length > 1 && offsets.at(-1) <= MAX_BOT_OFFSET;
  const element = Buffer.alloc(12);
  element.writeUInt16LE(0x7fe0, 0);
  element.writeUInt16LE(0x0010, 2);
  element.write("OB", 4, "latin1");
  element.writeUInt32LE(0xffffffff, 8);
  const bot = Buffer.alloc(useBot ? offsets.length * 4 : 0);
  offsets.forEach((o, i) => useBot && bot.writeUInt32LE(o, i * 4));
  return Buffer.concat([element, itemHeader(0xfffe, 0xe000, bot.length), bot]);
}

function nativeHeader(length, vr) {
  const element = Buffer.alloc(12);
  element.writeUInt16LE(0x7fe0, 0);
  element.writeUInt16LE(0x0010, 2);
  element.write(vr, 4, "latin1");
  element.writeUInt32LE(length + (length % 2), 8);
  return element;
}

/** Yields the spooled frames, each wrapped in its item header. */
async function* encapsulatedBody(spool) {
  const input = fs.createReadStream(spool.path, {
    highWaterMark: 8 * 1024 * 1024,
  });
  let index = 0;
  let remaining = spool.lengths[0] ?? 0;
  let started = false;
  for await (const chunk of input) {
    let offset = 0;
    while (offset < chunk.length) {
      if (!started) {
        const length = spool.lengths[index];
        yield itemHeader(0xfffe, 0xe000, length + (length % 2));
        started = true;
        remaining = length;
      }
      const take = Math.min(remaining, chunk.length - offset);
      yield chunk.subarray(offset, offset + take);
      offset += take;
      remaining -= take;
      if (remaining === 0) {
        if (spool.lengths[index] % 2) {
          yield Buffer.alloc(1);
        }
        index++;
        started = false;
      }
    }
  }
  // Zero-length frames never appear in the read loop.
  for (; index < spool.lengths.length; index++) {
    yield itemHeader(0xfffe, 0xe000, 0);
  }
  yield itemHeader(0xfffe, 0xe0dd, 0);
}

async function* nativeBody(spool) {
  yield* fs.createReadStream(spool.path, { highWaterMark: 8 * 1024 * 1024 });
  if (spool.bytes % 2) {
    yield Buffer.alloc(1);
  }
}

/**
 * Writes `{ meta, dict }` plus the spooled frames to `outputPath`. Elements
 * after PixelData (trailing padding, signatures) cannot follow rewritten
 * pixels, so they are dropped and their tags returned.
 *
 * @returns {Promise<{ fileBytes, pixelBytes, headerBytes, dropped }>}
 */
export async function writePart10WithFrames({
  dcmjs,
  outputPath,
  meta,
  dict,
  spool,
  encapsulated,
}) {
  await spool.close();
  const dropped = [];
  const header = {};
  for (const [tag, element] of Object.entries(dict)) {
    if (tag >= PIXEL_DATA) {
      if (tag !== PIXEL_DATA) {
        dropped.push(tag);
      }
      continue;
    }
    header[tag] = element;
  }

  const dicomDict = new dcmjs.data.DicomDict(meta);
  dicomDict.dict = header;
  const headerBytes = Buffer.from(dicomDict.write());

  const bitsAllocated = header["00280100"]?.Value?.[0] ?? 8;
  const pixelElementHeader = encapsulated
    ? encapsulatedHeader(spool.lengths)
    : nativeHeader(spool.bytes, bitsAllocated > 8 ? "OW" : "OB");
  const body = encapsulated ? encapsulatedBody(spool) : nativeBody(spool);

  async function* file() {
    yield headerBytes;
    yield pixelElementHeader;
    yield* body;
  }
  await pipeline(file, fs.createWriteStream(outputPath));

  const fileBytes = fs.statSync(outputPath).size;
  return {
    fileBytes,
    pixelBytes: spool.bytes,
    headerBytes: fileBytes - spool.bytes,
    dropped,
  };
}
