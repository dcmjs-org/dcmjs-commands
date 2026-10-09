// src/pixel/frameReader.js
//
// One streaming pass over a Part 10 file: the header is collected as a
// tag-keyed dict, and the top-level PixelData is handed out one frame at a
// time. Peak memory is the header plus one frame (encapsulated input) or the
// whole PixelData value (native input, which the reader delivers whole).

import fs from "node:fs";
import { nativeFrameBytes, imageInfoFromDict } from "./codec.js";

const PIXEL_DATA = "7FE00010";
const EXTENDED_OFFSET_TABLE = "7FE00001";
const EXTENDED_OFFSET_TABLE_LENGTHS = "7FE00002";

const toBytes = (chunk) =>
  chunk instanceof Uint8Array
    ? chunk
    : chunk instanceof ArrayBuffer
      ? new Uint8Array(chunk)
      : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);

function concat(parts) {
  if (parts.length === 1) {
    return parts[0];
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Item-header-relative frame offsets from (7FE0,0001), if present. */
function extendedOffsets(dict) {
  const raw = dict[EXTENDED_OFFSET_TABLE]?.Value?.[0];
  if (!raw) {
    return undefined;
  }
  const bytes = toBytes(raw);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offsets = [];
  for (let i = 0; i + 8 <= bytes.byteLength; i += 8) {
    offsets.push(Number(view.getBigUint64(i, true)));
  }
  return offsets;
}

const endsWithEoi = (bytes) => {
  const n = bytes.byteLength;
  return (
    (n >= 2 && bytes[n - 2] === 0xff && bytes[n - 1] === 0xd9) ||
    (n >= 3 &&
      bytes[n - 3] === 0xff &&
      bytes[n - 2] === 0xd9 &&
      bytes[n - 1] === 0)
  );
};

/**
 * Groups encapsulated fragments into frames (PS3.5 A.4): by the Basic or
 * Extended Offset Table when there is one; all fragments for a single
 * frame; otherwise at each fragment that ends with an EOI/EOC marker (the
 * JPEG, JPEG-LS and JPEG 2000 families), else one fragment per frame.
 */
class FrameAssembler {
  constructor({ offsets, numberOfFrames, markerFramed }) {
    this.offsets = offsets?.length ? offsets : undefined;
    this.single = !this.offsets && numberOfFrames <= 1;
    this.markerFramed = markerFramed;
    this.parts = [];
    this.position = 0;
    this.nextBoundary = 1;
  }

  /** Returns the frames this fragment completes. */
  push(fragment) {
    const frames = [];
    if (
      this.offsets &&
      this.parts.length &&
      this.position >= this.offsets[this.nextBoundary]
    ) {
      frames.push(concat(this.parts));
      this.parts = [];
      while (this.position >= this.offsets[this.nextBoundary]) {
        this.nextBoundary++;
      }
    }
    this.position += 8 + fragment.byteLength;
    this.parts.push(fragment);
    if (
      !this.offsets &&
      !this.single &&
      (!this.markerFramed || endsWithEoi(fragment))
    ) {
      frames.push(concat(this.parts));
      this.parts = [];
    }
    return frames;
  }

  finish() {
    const frames = this.parts.length ? [concat(this.parts)] : [];
    this.parts = [];
    return frames;
  }
}

class HeaderComplete extends Error {}

/**
 * The `{ meta, dict }` of `inputPath` up to PixelData, without reading the
 * pixel data: the stream is abandoned when PixelData starts.
 */
export async function readPart10Header({ dcmjs, inputPath }) {
  const { fromPart10Stream, CollectorListener } = dcmjs.eventStream;
  let depth = 0;
  const listener = new CollectorListener({
    startSequence(next, ...args) {
      depth++;
      return next(...args);
    },
    endSequence(next) {
      depth--;
      return next();
    },
    startElement(next, tag, info) {
      if (depth === 0 && tag === PIXEL_DATA) {
        throw new HeaderComplete();
      }
      return next(tag, info);
    },
  });
  const input = fs.createReadStream(inputPath, { highWaterMark: 1024 * 1024 });
  try {
    await fromPart10Stream(input, listener);
  } catch (err) {
    if (!(err instanceof HeaderComplete)) {
      throw err;
    }
  } finally {
    input.destroy();
  }
  return listener.result;
}

const MARKER_FRAMED =
  /^1\.2\.840\.10008\.1\.2\.4\.(5\d|6\d|70|8[01]|9[0-3]|20[123])$/;

/**
 * Reads `inputPath` once.
 *
 * @param {object} args
 * @param {object} args.dcmjs
 * @param {string} args.inputPath
 * @param {(header: {meta, dict}) => void} [args.onHeader] called when the
 *   PixelData element starts, with every element before it.
 * @param {(frame: Uint8Array, index: number) => Promise<void>} args.onFrame
 *   awaited for each frame in order; the next frame is not read until it
 *   resolves.
 * @returns {Promise<{meta, dict, transferSyntaxUID, frames, pixelBytes,
 *   fileBytes, encapsulated}>} `dict` holds every element except PixelData
 *   and the offset tables.
 */
export async function readPart10Frames({
  dcmjs,
  inputPath,
  onHeader,
  onFrame,
}) {
  const { fromPart10Stream, CollectorListener } = dcmjs.eventStream;

  let depth = 0;
  let inPixelData = false;
  let encapsulated = false;
  let assembler;
  let headerSeen = false;
  let currentTag;
  let transferSyntaxUID;
  let frameIndex = 0;
  let pixelBytes = 0;
  const queue = [];
  const nativeParts = [];
  let ended = false;
  let nativeFrameSize = 0;

  const filter = {
    startSequence(next, ...args) {
      depth++;
      return next(...args);
    },
    endSequence(next) {
      depth--;
      return next();
    },
    startElement(next, tag, info) {
      currentTag = tag;
      if (depth === 0 && tag === PIXEL_DATA) {
        inPixelData = true;
        headerSeen = true;
        onHeader?.(this.result);
        return undefined;
      }
      return next(tag, info);
    },
    value(next, v, opts) {
      if (currentTag === "00020010") {
        transferSyntaxUID = v;
      }
      return next(v, opts);
    },
    startBinary(next, opts = {}) {
      if (!inPixelData) {
        return next(opts);
      }
      encapsulated = Boolean(opts.encapsulated);
      const dict = this.result.dict;
      const numberOfFrames = Number(dict["00280008"]?.Value?.[0] ?? 1);
      if (encapsulated) {
        assembler = new FrameAssembler({
          offsets: opts.basicOffsetTable?.length
            ? opts.basicOffsetTable
            : extendedOffsets(dict),
          numberOfFrames,
          markerFramed: MARKER_FRAMED.test(transferSyntaxUID ?? ""),
        });
      } else {
        nativeFrameSize = nativeFrameBytes(imageInfoFromDict(dict));
      }
      return undefined;
    },
    binaryFragment(next, chunk) {
      if (!inPixelData) {
        return next(chunk);
      }
      const bytes = toBytes(chunk);
      pixelBytes += bytes.byteLength;
      if (encapsulated) {
        queue.push(bytes);
      } else {
        nativeParts.push(bytes);
      }
      return undefined;
    },
    endBinary(next) {
      if (!inPixelData) {
        return next();
      }
      ended = true;
      return undefined;
    },
    endElement(next) {
      if (inPixelData) {
        inPixelData = false;
        return undefined;
      }
      return next();
    },
  };

  const listener = new CollectorListener(filter);

  // The reader awaits the drain gate after each encapsulated fragment and
  // after each top-level element, so frames are transcoded here, in order,
  // before the reader moves on.
  listener.setDrain(async () => {
    while (queue.length) {
      for (const frame of assembler.push(queue.shift())) {
        await onFrame(frame, frameIndex++);
      }
    }
    if (ended) {
      ended = false;
      if (encapsulated) {
        for (const frame of assembler.finish()) {
          await onFrame(frame, frameIndex++);
        }
      } else {
        const all = concat(nativeParts);
        nativeParts.length = 0;
        for (
          let o = 0;
          o + nativeFrameSize <= all.byteLength;
          o += nativeFrameSize
        ) {
          await onFrame(all.subarray(o, o + nativeFrameSize), frameIndex++);
        }
      }
    }
  });

  await fromPart10Stream(
    fs.createReadStream(inputPath, { highWaterMark: 8 * 1024 * 1024 }),
    listener
  );

  const { meta, dict } = listener.result;
  delete dict[EXTENDED_OFFSET_TABLE];
  delete dict[EXTENDED_OFFSET_TABLE_LENGTHS];
  return {
    meta,
    dict,
    transferSyntaxUID: transferSyntaxUID ?? meta["00020010"]?.Value?.[0],
    hasPixelData: headerSeen,
    encapsulated,
    frames: frameIndex,
    pixelBytes,
    fileBytes: fs.statSync(inputPath).size,
  };
}
