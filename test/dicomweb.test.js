// test/dicomweb.test.js

import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import http from "http";
import { readDicomWeb, readDicomWebFile } from "../src/dicomweb.js";

let tmpDir;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcmjs-commands-dw-"));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("readDicomWebFile reads plain JSON files", () => {
  const data = [{ "00080060": { vr: "CS", Value: ["MR"] } }];
  const file = path.join(tmpDir, "query.json");
  fs.writeFileSync(file, JSON.stringify(data));
  expect(readDicomWebFile(file)).toEqual(data);
});

test("readDicomWebFile reads gzipped JSON files (small file, pooled Buffer)", () => {
  const data = { small: true };
  const file = path.join(tmpDir, "query.json.gz");
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(data)));
  expect(readDicomWebFile(file)).toEqual(data);
});

test("readDicomWeb routes http URLs to the web client", async () => {
  const payload = [{ ok: true }];
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const result = await readDicomWeb(`http://127.0.0.1:${port}/studies`);
    expect(result).toEqual(payload);
  } finally {
    server.close();
  }
});

test("readDicomWeb routes non-http paths to the file reader", () => {
  const data = { file: "route" };
  const file = path.join(tmpDir, "route.json");
  fs.writeFileSync(file, JSON.stringify(data));
  expect(readDicomWeb(file)).toEqual(data);
});
