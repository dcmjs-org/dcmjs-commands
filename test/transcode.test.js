// test/transcode.test.js
//
// dcmjs transcode — frame-by-frame transfer syntax conversion.

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { runTranscode } from "../src/commands/transcode.js";
import {
  readPart10Frames,
  readPart10Header,
} from "../src/pixel/frameReader.js";
import { writeSyntheticWsi } from "./helpers/syntheticWsi.js";

const require = createRequire(import.meta.url);
const dcmjs = require("dcmjs");
dcmjs.log.setLevel("silent");

let tmpDir;
let wsi;
beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcmjs-transcode-"));
  wsi = await writeSyntheticWsi(dcmjs, path.join(tmpDir, "source"));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function transcode(positionals, values) {
  const out = [];
  const err = [];
  const code = await runTranscode({
    dcmjs,
    positionals,
    values,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  });
  return { code, text: out.join("\n"), err: err.join("\n") };
}

async function frameHashes(file) {
  const hashes = [];
  await readPart10Frames({
    dcmjs,
    inputPath: file,
    onFrame: async (frame) =>
      hashes.push(crypto.createHash("sha256").update(frame).digest("hex")),
  });
  return hashes;
}

const first = async (file, tag) =>
  (await readPart10Header({ dcmjs, inputPath: file })).dict[tag]?.Value?.[0];

// API: .111 is a lossless container for the JPEG bitstream.
test("jxl-jpeg in place, then jpeg back, gives every JPEG frame byte for byte", async () => {
  const work = path.join(tmpDir, "roundtrip");
  fs.cpSync(path.dirname(wsi.base.path), work, { recursive: true });
  const original = await frameHashes(wsi.base.path);

  const there = await transcode([work], { to: "jxl-jpeg", json: true });
  expect(there.code).toBe(0);
  const report = JSON.parse(there.text);
  expect(report.before.instances).toBe(3);
  expect(report.after.pixelBytes).toBeLessThan(report.before.pixelBytes);
  const inPlace = path.join(work, "base.dcm");
  expect(
    (await readPart10Header({ dcmjs, inputPath: inPlace })).meta["00020010"]
      .Value[0]
  ).toBe("1.2.840.10008.1.2.4.111");

  const back = path.join(tmpDir, "back");
  expect((await transcode([work], { to: "jpeg", directory: back })).code).toBe(
    0
  );
  const restored = path.join(back, "base.dcm");
  expect(await frameHashes(restored)).toEqual(original);
  expect(await first(restored, "00080018")).toBe(wsi.base.sop);
});

// User experience: loss is never silent.
test("a lossy target needs --lossy, and the lossy file gets a new SOPInstanceUID", async () => {
  const refused = await transcode([wsi.base.path], {
    to: "jxl",
    directory: path.join(tmpDir, "refused"),
  });
  expect(refused.code).toBe(1);
  expect(refused.err).toMatch(/pass --lossy/);

  const outDir = path.join(tmpDir, "lossy");
  const lossy = await transcode([wsi.base.path], {
    to: "jxl",
    lossy: true,
    distance: "2",
    directory: outDir,
  });
  expect(lossy.code).toBe(0);
  expect(lossy.text).toMatch(/before .*\n.*after/s);
  const file = path.join(outDir, "base.dcm");
  const { dict } = await readPart10Header({ dcmjs, inputPath: file });
  expect(dict["00080018"].Value[0]).not.toBe(wsi.base.sop);
  expect(dict["00280004"].Value[0]).toBe("RGB");
  expect(dict["00282114"].Value).toEqual(["ISO_10918_1", "ISO_18181_1"]);
  expect(dict["00282112"].Value).toHaveLength(2);
});
