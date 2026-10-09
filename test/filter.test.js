// test/filter.test.js
//
// dcmjs filter — streaming file-to-file copy through an event-stream filter
// chain. The identity copy (no filters) is itself the core test: the output
// must re-parse with the same tags, VRs, and byte-exact binary values as the
// source, proving the fromPart10Stream -> StreamingPart10Writer pipeline is
// lossless for everyday files, not just the giant video fixture.

import path from "path";
import fs from "fs";
import os from "os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const dcmjs = require("dcmjs");
dcmjs.log.setLevel("silent");
dcmjs.log.getLogger("validation.dcmjs").setLevel("silent");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { runFilter } from "../src/commands/filter.js";

const FIXTURE = path.join(__dirname, "fixtures", "sample-dicom.dcm");

let tmpDir;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcmjs-filter-"));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function capture() {
  const lines = [];
  return { lines, write: (text) => lines.push(text) };
}

async function filter(positionals, values = {}) {
  const out = capture();
  const err = capture();
  const code = await runFilter({
    dcmjs,
    positionals,
    values,
    stdout: out.write,
    stderr: err.write,
  });
  return { code, text: out.lines.join("\n"), err: err.lines.join("\n") };
}

function readDict(file) {
  const buf = fs.readFileSync(file);
  return dcmjs.data.DicomMessage.readFile(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  );
}

test("identity copy preserves tags, VRs, and binary bytes", async () => {
  const outFile = path.join(tmpDir, "identity.dcm");
  const { code } = await filter([FIXTURE], { output: outFile });
  expect(code).toBe(0);

  const src = readDict(FIXTURE);
  const dst = readDict(outFile);

  const srcTags = Object.keys(src.dict).sort();
  const dstTags = Object.keys(dst.dict).sort();
  expect(dstTags).toEqual(srcTags);

  for (const tag of srcTags) {
    expect(dst.dict[tag].vr).toBe(src.dict[tag].vr);
  }

  // Byte-exact binary round trip, including the private UN elements.
  for (const tag of ["20011003", "2001100A", "7FE00010"]) {
    const a = new Uint8Array(src.dict[tag].Value[0]);
    const b = new Uint8Array(dst.dict[tag].Value[0]);
    expect(b.length).toBe(a.length);
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
  }

  expect(dst.dict["00100010"].Value[0].Alphabetic).toBe("Fall 3");
});

test("--set replaces a value in place", async () => {
  const outFile = path.join(tmpDir, "set.dcm");
  const { code } = await filter([FIXTURE], {
    output: outFile,
    set: ["00100010=Anonymous"],
  });
  expect(code).toBe(0);

  const dst = readDict(outFile);
  expect(dst.dict["00100010"].Value[0].Alphabetic).toBe("Anonymous");
  // Everything else untouched.
  expect(new Uint8Array(dst.dict["7FE00010"].Value[0]).length).toBe(524288);
});

test("--drop removes leaf elements and whole sequences", async () => {
  const outFile = path.join(tmpDir, "drop.dcm");
  const { code } = await filter([FIXTURE], {
    output: outFile,
    drop: ["00100010", "00081140"],
  });
  expect(code).toBe(0);

  const src = readDict(FIXTURE);
  const dst = readDict(outFile);
  expect(dst.dict["00100010"]).toBeUndefined();
  expect(dst.dict["00081140"]).toBeUndefined();
  // Other sequences survive, with their item counts.
  expect(dst.dict["00081111"].Value.length).toBe(
    src.dict["00081111"].Value.length
  );
  // Only the two dropped tags are gone.
  expect(Object.keys(src.dict).length - Object.keys(dst.dict).length).toBe(2);
});

test("--module loads a custom filter chain from a file", async () => {
  const modFile = path.join(tmpDir, "uppercase-institution.mjs");
  fs.writeFileSync(
    modFile,
    `export default {
      _tag: null,
      startElement(next, tag, info) { this._tag = tag; return next(tag, info); },
      endElement(next) { this._tag = null; return next(); },
      value(next, v, opts) {
        return next(this._tag === "00080080" ? String(v).toUpperCase() : v, opts);
      }
    };\n`
  );
  const outFile = path.join(tmpDir, "module.dcm");
  const { code } = await filter([FIXTURE], {
    output: outFile,
    module: [modFile],
  });
  expect(code).toBe(0);

  const src = readDict(FIXTURE);
  const dst = readDict(outFile);
  const before = src.dict["00080080"].Value[0];
  expect(dst.dict["00080080"].Value[0]).toBe(String(before).toUpperCase());
});

test("missing output flag is an error with usage on stderr", async () => {
  const { code, err } = await filter([FIXTURE], {});
  expect(code).toBe(1);
  expect(err).toContain("usage");
});

test("--help prints usage and exits 0", async () => {
  const { code, text } = await filter([], { help: true });
  expect(code).toBe(0);
  expect(text).toContain("usage");
});
