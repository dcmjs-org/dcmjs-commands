// test/fileSink.test.js
//
// createFileSink — the shared write-stream lifecycle for file-producing
// commands. The contract under test: stream errors surface through
// write()/drain()/finish() instead of crashing the process, abort()
// leaves no partial file, and an in-place rewrite is refused before the
// output stream can truncate the input.

import fs from "fs";
import os from "os";
import path from "path";
import { createFileSink } from "../src/io.js";

let tmpDir;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcmjs-sink-"));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("writes chunks and finishes", async () => {
  const out = path.join(tmpDir, "ok.bin");
  const sink = createFileSink(out);
  sink.write(Buffer.from("hello "));
  sink.write(Buffer.from("world"));
  await sink.drain();
  await sink.finish();
  expect(fs.readFileSync(out, "utf8")).toBe("hello world");
});

test("same output and input path is refused before the stream opens", () => {
  const file = path.join(tmpDir, "inplace.dcm");
  fs.writeFileSync(file, "precious");
  expect(() =>
    createFileSink(path.join(tmpDir, ".", "inplace.dcm"), { inputPath: file })
  ).toThrow(/refusing to overwrite the input file in place/);
  expect(fs.readFileSync(file, "utf8")).toBe("precious");
});

test("a stream error rejects finish() instead of crashing", async () => {
  const out = path.join(tmpDir, "no-such-dir", "out.bin");
  const sink = createFileSink(out);
  sink.write(Buffer.from("doomed"));
  await expect(sink.finish()).rejects.toThrow(/ENOENT/);
  sink.abort();
  expect(fs.existsSync(out)).toBe(false);
});

test("a stream error rejects a pending drain()", async () => {
  const out = path.join(tmpDir, "no-such-dir-2", "out.bin");
  const sink = createFileSink(out);
  // Force backpressure so drain() actually waits on the raced promise.
  const big = Buffer.alloc(32 * 1024 * 1024);
  sink.write(big);
  await expect(sink.drain()).rejects.toThrow(/ENOENT/);
  sink.abort();
});

test("abort removes the partial output file and is idempotent", async () => {
  const out = path.join(tmpDir, "partial.bin");
  const sink = createFileSink(out);
  sink.write(Buffer.from("partial"));
  await sink.drain();
  sink.abort();
  sink.abort();
  expect(fs.existsSync(out)).toBe(false);
});
