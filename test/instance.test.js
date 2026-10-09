// test/instance.test.js

import path from "path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const dcmjs = require("dcmjs");
dcmjs.log.setLevel("silent");
dcmjs.log.getLogger("validation.dcmjs").setLevel("silent");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { runInstance } from "../src/commands/instance.js";

const FIXTURE = path.join(__dirname, "fixtures", "sample-dicom.dcm");

function capture() {
  const lines = [];
  return { lines, write: (text) => lines.push(text) };
}

async function instance(values, positionals = [FIXTURE]) {
  const out = capture();
  const err = capture();
  const code = await runInstance({
    dcmjs,
    positionals,
    values,
    stdout: out.write,
    stderr: err.write,
  });
  return { code, text: out.lines.join("\n"), err: err.lines.join("\n") };
}

test("instance prints the dict as DICOM JSON (legacy behavior)", async () => {
  const { code, text } = await instance({});
  expect(code).toBe(0);
  const parsed = JSON.parse(text);
  // Tag-keyed { vr, Value } shape, straight from the parsed dict
  expect(parsed["00100010"].vr).toBe("PN");
  expect(parsed["00100010"].Value[0].Alphabetic).toBe("Fall 3");
});

test("instance --pretty is multi-line and still parseable", async () => {
  const { code, text } = await instance({ pretty: true });
  expect(code).toBe(0);
  expect(text.split("\n").length).toBeGreaterThan(10);
  expect(JSON.parse(text)["00080060"].Value[0]).toBe("MR");
});

test("instance errors cleanly on a missing file", async () => {
  const { code, err } = await instance({}, ["/no/such/file.dcm"]);
  expect(code).toBe(1);
  expect(err).toMatch(/no such file|ENOENT/i);
});
