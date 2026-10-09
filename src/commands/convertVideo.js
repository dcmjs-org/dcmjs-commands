// src/commands/convertVideo.js
//
// Streaming video conversion, both directions:
//
//   convertMp4ToDicom — encapsulate an MP4 verbatim as a Video Photographic
//       Image instance (Supplement 225 fragmentable H.264 syntaxes). The MP4
//       is read fragment-by-fragment through a file-descriptor reader and
//       written through StreamingPart10Writer, so peak memory is one
//       fragment regardless of file size (a 21.8 GB input works unchanged).
//
//   convertDicomToMp4 — recover the byte-identical original stream: the
//       encapsulated PixelData fragments are concatenated to the output
//       file, truncated to the declared (7FE0,0003) total length (dropping
//       the pad byte a Part 10 writer adds to an odd final fragment).
//
// Neither direction ever buffers the whole file — these paths deliberately
// bypass readFileArrayBuffer.

import fs from "node:fs";
import { once } from "node:events";

/** Random-access reader over an open file, for DicomEventStream.fromVideoStream. */
async function openFileReader(inputPath) {
  const handle = await fs.promises.open(inputPath, "r");
  const { size } = await handle.stat();
  return {
    size,
    async read(offset, length) {
      // Buffer.alloc is never pooled, so the view spans its whole backing
      // buffer and flows through the event stream copy-free.
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      return new Uint8Array(buffer.buffer, buffer.byteOffset, length);
    },
    close: () => handle.close(),
  };
}

/** Parse --fragment-bytes; dcmjs re-validates even/range with its own error. */
export function parseFragmentBytes(values) {
  const raw = values["fragment-bytes"];
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--fragment-bytes must be a number of bytes, got '${raw}'`);
  }
  return parsed;
}

/**
 * mp4 → dcm, streaming. `options` carries the naturalized overrides
 * (PatientName, StudyInstanceUID, FHIR-derived attrs, ...).
 */
export async function convertMp4ToDicom({
  dcmjs,
  input,
  output,
  options,
  fragmentBytes,
  stderr,
}) {
  const { DicomEventStream, StreamingPart10Writer } = dcmjs.eventStream;

  const reader = await openFileReader(input);
  const out = fs.createWriteStream(output);
  let pending = false;
  const writer = new StreamingPart10Writer({
    onChunk: (chunk) => {
      if (!out.write(chunk)) {
        pending = true;
      }
    },
  });
  writer.setDrain(async () => {
    if (pending) {
      pending = false;
      await once(out, "drain");
    }
  });

  try {
    const events = DicomEventStream.fromVideoStream(reader, {
      ...options,
      fragmentBytes,
    });
    await events.process(writer);
    out.end();
    await once(out, "finish");
  } catch (err) {
    out.destroy();
    fs.rmSync(output, { force: true });
    throw err;
  } finally {
    await reader.close();
  }

  const fragmentSize =
    fragmentBytes ?? dcmjs.encapsulated.DEFAULT_FRAGMENT_BYTES;
  const fragments = Math.ceil(reader.size / fragmentSize);
  stderr(
    `convert: encapsulated ${reader.size.toLocaleString("en-US")} MP4 bytes ` +
      `as ${fragments} fragment${fragments === 1 ? "" : "s"} → ${output} ` +
      `(${writer.bytesWritten.toLocaleString("en-US")} bytes)`
  );
  return 0;
}

const VIDEO_TS_PATTERN = /^1\.2\.840\.10008\.1\.2\.4\.10[0-8](\.1)?$/;
const PIXEL_DATA_TAG = "7FE00010";
const TOTAL_LENGTH_TAG = "7FE00003";

/**
 * dcm (video) → mp4, streaming: an event-stream listener that writes the
 * encapsulated PixelData fragments straight to the output file. Backpressure
 * wires the write stream's drain to the generator's per-fragment checkpoint.
 */
export async function convertDicomToMp4({ dcmjs, input, output, stderr }) {
  const { fromPart10Stream, EventStreamListener } = dcmjs.eventStream;

  const out = fs.createWriteStream(output);
  let pending = false;

  class ExtractVideoListener extends EventStreamListener {
    constructor() {
      super();
      this.declaredTotal = null;
      this.written = 0;
      this.fragments = 0;
      this.extracting = false;
      this.sawPixelData = false;
      this.transferSyntaxUID = undefined;
      this._currentTag = null;
    }

    // The streaming reader normalizes the syntax it reports at startDataSet
    // to a body framing (encapsulated syntaxes read as explicit LE), so the
    // REAL transfer syntax must come from the (0002,0010) meta element.
    _baseEndFileMetaInformation() {
      const uid = this.transferSyntaxUID;
      if (uid && !VIDEO_TS_PATTERN.test(uid)) {
        throw new Error(
          `not a video instance (TransferSyntaxUID ${uid}) — ` +
            "dcm → mp4 needs an MPEG2/H.264 encapsulated video instance; " +
            "use --to json, --to pdf, or --to dcm for this file"
        );
      }
    }

    _baseStartElement(tag) {
      this._currentTag = tag;
    }

    _baseValue(value) {
      if (this._currentTag === "00020010") {
        this.transferSyntaxUID = value;
      }
      if (this._currentTag === TOTAL_LENGTH_TAG) {
        this.declaredTotal = BigInt(value);
      }
    }

    _baseStartBinary(opts = {}) {
      if (this._currentTag !== PIXEL_DATA_TAG) {
        return;
      }
      this.sawPixelData = true;
      if (!opts.encapsulated) {
        throw new Error(
          "PixelData is not encapsulated — this is not a Supplement 225 " +
            "video instance; use --to json or --to dcm instead"
        );
      }
      this.extracting = true;
    }

    _baseBinaryFragment(chunk) {
      const bytes =
        chunk instanceof Uint8Array
          ? chunk
          : chunk instanceof ArrayBuffer
            ? new Uint8Array(chunk)
            : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);

      // A UV element can reach us as an 8-byte binary when the source wrote
      // it with VR UN (implicit syntax or older writers): decode it.
      if (this._currentTag === TOTAL_LENGTH_TAG && bytes.byteLength === 8) {
        const view = new DataView(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength
        );
        this.declaredTotal = view.getBigUint64(0, true);
        return;
      }
      if (!this.extracting) {
        return;
      }

      this.fragments++;
      const remaining =
        this.declaredTotal === null
          ? BigInt(bytes.byteLength)
          : this.declaredTotal - BigInt(this.written);
      if (remaining <= 0n) {
        return; // everything past the declared total is padding
      }
      const take =
        remaining < BigInt(bytes.byteLength)
          ? bytes.subarray(0, Number(remaining))
          : bytes;
      this.written += take.byteLength;
      if (
        !out.write(Buffer.from(take.buffer, take.byteOffset, take.byteLength))
      ) {
        pending = true;
      }
    }

    _baseEndBinary() {
      if (this._currentTag === PIXEL_DATA_TAG) {
        this.extracting = false;
      }
    }
  }

  const listener = new ExtractVideoListener();
  listener.setDrain(async () => {
    if (pending) {
      pending = false;
      await once(out, "drain");
    }
  });

  try {
    await fromPart10Stream(
      fs.createReadStream(input, { highWaterMark: 8 * 1024 * 1024 }),
      listener
    );
    out.end();
    await once(out, "finish");
  } catch (err) {
    out.destroy();
    fs.rmSync(output, { force: true });
    throw err;
  }

  if (!listener.sawPixelData) {
    fs.rmSync(output, { force: true });
    throw new Error(
      "no encapsulated PixelData found — the instance carries no video stream"
    );
  }
  if (listener.declaredTotal === null) {
    stderr(
      "convert: warning: no (7FE0,0003) total length declared — wrote every " +
        "fragment byte; an odd-length stream may carry one trailing pad byte"
    );
  }
  stderr(
    `convert: extracted ${listener.written.toLocaleString("en-US")} bytes ` +
      `from ${listener.fragments} fragment${listener.fragments === 1 ? "" : "s"} ` +
      `(transfer syntax ${listener.transferSyntaxUID}) → ${output}`
  );
  return 0;
}
