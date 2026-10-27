// test/utils/jsonStreams.test.js

import fs from "fs";
import os from "os";
import path from "path";
import { saveJson } from "../../src/utils/saveJson.js";
import { loadJson } from "../../src/utils/loadJson.js";
import { writeStream } from "../../src/utils/writeStream.js";

let tmpDir;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcmjs-commands-json-"));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("saveJson/loadJson round-trip gzipped JSON", async () => {
  const data = { hello: "world", n: 42, nested: { list: [1, 2, 3] } };
  await saveJson(tmpDir, "roundtrip.json.gz", data);
  const loaded = await loadJson(tmpDir, "roundtrip.json.gz");
  expect(loaded).toEqual(data);
});

test("saveJson/loadJson round-trip plain JSON", async () => {
  const data = { plain: true };
  await saveJson(tmpDir, "plain.json", data);
  const loaded = await loadJson(tmpDir, "plain.json");
  expect(loaded).toEqual(data);
});

test("loadJson returns defaultReturn for missing files", async () => {
  const fallback = { missing: true };
  const loaded = await loadJson(tmpDir, "does-not-exist.json", fallback);
  expect(loaded).toBe(fallback);
});

test("writeStream leaves no temp files behind", async () => {
  const out = await writeStream(tmpDir, "atomic.json.gz", { mkdir: true });
  await out.writeWithPromise('{"ok":true}');
  await out.close();

  const leftovers = fs
    .readdirSync(tmpDir)
    .filter((name) => name.startsWith("tempFile-"));
  expect(leftovers).toEqual([]);
  expect(fs.existsSync(path.join(tmpDir, "atomic.json.gz"))).toBe(true);
});
