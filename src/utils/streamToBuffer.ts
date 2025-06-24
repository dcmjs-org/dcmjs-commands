import { createReadStream } from "node:fs";
import { once } from "node:events";

export async function frameToBuffer(readable) {
  if( readable.buffer ) {
    return readable;
  }
  throw new Error("TODO - implement this");
  // TODO - read buffer and tsuid here
  return {
    buffer: new Uint8Array([1,2,3]).buffer,
    transferSyntaxUID: "1.2.10008.1.2.4.80",
  }
}

/**
 * Collects everything emitted by a readable stream into one Uint8Array.
 * @param {NodeJS.ReadableStream} readable  An fs.createReadStream(...) or any Readable.
 * @returns {Promise<Uint8Array>}
 */
export async function streamToUint8Array(readable) {
  const chunks = [];

  // Accumulate each Buffer chunk
  readable.on("data", (chunk) => chunks.push(chunk));

  // Wait for the stream to finish (or error)
  await Promise.race([
    once(readable, "end"),
    once(readable, "error").then(([err]) => {
      throw err;
    }),
  ]);

  // Concatenate into a single Buffer first (fast native code)
  const buf = Buffer.concat(chunks);

  // Re-expose the same bytes as Uint8Array *without* copying
  return new Uint8Array(
    buf.buffer, // underlying ArrayBuffer
    buf.byteOffset, // start of data
    buf.byteLength // number of bytes
  );
}

