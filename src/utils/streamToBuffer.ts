import { multipartDecode } from "./message";
import { once } from "node:events";
import { Readable } from "node:stream";

export async function frameToBuffer(readable) {
  if (readable.buffer) {
    return readable;
  }

  const multipart = await streamToUint8Array(readable.stream);
  const decoded = multipartDecode(multipart);
  const [dataview] = decoded;
  console.warn("Decoded", dataview.length, dataview.transferSyntaxUID);
  return {
    buffer: dataview.buffer,
    transferSyntaxUID: dataview.transferSyntaxUID,
    isEncapsulated: false,
  };
}

/**
 * Collects everything emitted by a readable stream into one Uint8Array.
 * @param {NodeJS.ReadableStream} readable  An fs.createReadStream(...) or any Readable.
 * @returns {Promise<Uint8Array>}
 */
export async function streamToUint8Array(source) {
  const chunks = [];

  // Case 1: Async iterable (Promises API)
  if (typeof source[Symbol.asyncIterator] === "function") {
    for await (const chunk of source) {
      chunks.push(chunk);
    }

    // Case 2: Node Readable stream (EventEmitter-style)
  } else if (source instanceof Readable || typeof source.on === "function") {
    source.on("data", (chunk) => chunks.push(chunk));

    await Promise.race([
      once(source, "end"),
      once(source, "error").then(([err]) => {
        throw err;
      }),
    ]);
  } else {
    throw new TypeError("Unsupported stream type");
  }

  const buf = Buffer.concat(chunks);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
