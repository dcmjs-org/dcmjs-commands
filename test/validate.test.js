// test/validate.test.js

import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const dcmjs = require("dcmjs");
dcmjs.log.setLevel("silent");
dcmjs.log.getLogger("validation.dcmjs").setLevel("silent");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { runValidate } from "../src/commands/validate.js";

// The conformance engine (dcmjs.validate + ValidationListener) is v2-only.
// On 1.0-beta dcmjs it arrives later with @dcmjs-org/validator, so the
// conformance tests skip there and the corrective-message test runs instead.
const HAS_CONFORMANCE_ENGINE =
  typeof dcmjs.validate === "function" &&
  typeof dcmjs.validation?.ValidationListener === "function";
const testConformance = HAS_CONFORMANCE_ENGINE ? test : test.skip;
const testNoEngine = HAS_CONFORMANCE_ENGINE ? test.skip : test;

const FIXTURE = path.join(__dirname, "fixtures", "sample-dicom.dcm");

function capture() {
  const lines = [];
  return { lines, write: (text) => lines.push(text) };
}

let tmpDir;
let conformanceDir;
let brokenPath;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcmjs-cli-validate-"));
  // A clean file and a truncated (unparseable) sibling
  fs.copyFileSync(FIXTURE, path.join(tmpDir, "good.dcm"));
  const bytes = fs.readFileSync(FIXTURE);
  fs.writeFileSync(path.join(tmpDir, "truncated.dcm"), bytes.subarray(0, 160));

  // Separate dir so the directory-scan tests above keep their exact counts.
  // broken.dcm is the fixture with its Type 1 Rows attribute removed — the
  // canonical nonconformant-but-parseable file.
  conformanceDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcmjs-cli-conform-"));
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  );
  const dicomDict = dcmjs.data.DicomMessage.readFile(arrayBuffer);
  delete dicomDict.dict["00280010"];
  brokenPath = path.join(conformanceDir, "broken.dcm");
  fs.writeFileSync(brokenPath, Buffer.from(dicomDict.write()));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(conformanceDir, { recursive: true, force: true });
});

test("validate reports ok and exits 0 for a clean file", async () => {
  const out = capture();
  const err = capture();
  const code = await runValidate({
    dcmjs,
    positionals: [FIXTURE],
    values: {},
    stdout: out.write,
    stderr: err.write,
  });
  expect(code).toBe(0);
  const text = out.lines.join("\n");
  expect(text).toMatch(/ok\s+/);
  expect(text).toMatch(/1\/1 clean/);
});

test("validate discovers directories and exits 1 on failures", async () => {
  const out = capture();
  const err = capture();
  const code = await runValidate({
    dcmjs,
    positionals: [tmpDir],
    values: {},
    stdout: out.write,
    stderr: err.write,
  });
  expect(code).toBe(1);
  const text = out.lines.join("\n");
  expect(text).toMatch(/FAIL/);
  expect(text).toMatch(/1\/2 clean, 1 failed/);
});

test("validate --json writes a machine-readable report", async () => {
  const out = capture();
  const err = capture();
  const reportPath = path.join(tmpDir, "report.json");
  const code = await runValidate({
    dcmjs,
    positionals: [tmpDir],
    values: { quiet: true, json: reportPath },
    stdout: out.write,
    stderr: err.write,
  });
  expect(code).toBe(1);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const statuses = report.map((record) => record.status).sort();
  expect(statuses).toEqual(["fail", "ok"]);
});

test("validate errors when given no inputs", async () => {
  const out = capture();
  const err = capture();
  const code = await runValidate({
    dcmjs,
    positionals: [],
    values: {},
    stdout: out.write,
    stderr: err.write,
  });
  expect(code).toBe(1);
  expect(err.lines.join("\n")).toMatch(/no input/i);
});

test("validateFiles streams files above the threshold (streamed: true)", async () => {
  const { validateFiles } = await import("../src/commands/validate.js");
  // Tiny threshold forces the fixture through the streaming parser.
  const { records, failures } = await validateFiles({
    dcmjs,
    targets: [FIXTURE],
    streamThreshold: 1024,
  });
  expect(failures).toBe(0);
  expect(records[0].status).toBe("ok");
  expect(records[0].streamed).toBe(true);
  expect(records[0].bytes).toBe(fs.statSync(FIXTURE).size);

  // A non-DICOM file still fails through the streaming path. (Streamed
  // validation is completeness-checked but shallower than the eager parse:
  // EOF right after the meta group reads as an empty dataset.)
  const junkPath = path.join(tmpDir, "junk-stream.dcm");
  fs.writeFileSync(junkPath, Buffer.alloc(4096, 0x41));
  const junk = await validateFiles({
    dcmjs,
    targets: [junkPath],
    streamThreshold: 16,
  });
  expect(junk.failures).toBe(1);
  expect(junk.records[0].status).toBe("fail");
});

testConformance(
  "validate --conformance passes a clean file and reports counts",
  async () => {
    const out = capture();
    const err = capture();
    const code = await runValidate({
      dcmjs,
      positionals: [FIXTURE],
      values: { conformance: true },
      stdout: out.write,
      stderr: err.write,
    });
    expect(code).toBe(0);
    const text = out.lines.join("\n");
    expect(text).toMatch(/ok\s+.*\(\d+ warnings, \d+ infos\)/);
    expect(text).toMatch(/0 nonconformant/);
  }
);

testConformance(
  "validate --layers 1,2,3 flags a file missing its Type 1 Rows",
  async () => {
    const out = capture();
    const err = capture();
    const code = await runValidate({
      dcmjs,
      positionals: [brokenPath],
      values: { layers: "1,2,3" },
      stdout: out.write,
      stderr: err.write,
    });
    expect(code).toBe(1);
    const text = out.lines.join("\n");
    expect(text).toMatch(/NONCONFORMANT/);
    expect(text).toMatch(/iod\.type1\.missing/);
    expect(text).toMatch(/Rows/);
    expect(text).toMatch(/1 nonconformant/);
  }
);

test("validate rejects a --layers value outside 1,2,3", async () => {
  const out = capture();
  const err = capture();
  const code = await runValidate({
    dcmjs,
    positionals: [FIXTURE],
    values: { layers: "1,9" },
    stdout: out.write,
    stderr: err.write,
  });
  expect(code).toBe(1);
  expect(err.lines.join("\n")).toMatch(/--layers/);
});

testConformance(
  "streamed conformance matches eager: ValidationListener path",
  async () => {
    const { validateFiles } = await import("../src/commands/validate.js");
    const conformance = { layers: [1, 2, 3] };
    const streamed = await validateFiles({
      dcmjs,
      targets: [brokenPath],
      streamThreshold: 1024,
      conformance,
    });
    expect(streamed.records[0].streamed).toBe(true);
    expect(streamed.records[0].status).toBe("nonconformant");
    const rules = (streamed.records[0].issues || []).map((issue) => issue.rule);
    expect(rules).toContain("iod.type1.missing");

    const eager = await validateFiles({
      dcmjs,
      targets: [brokenPath],
      conformance,
    });
    expect(eager.records[0].conformance.errors).toBe(
      streamed.records[0].conformance.errors
    );
  }
);

testNoEngine(
  "--conformance without the engine exits 1 with a corrective message",
  async () => {
    const out = capture();
    const err = capture();
    const code = await runValidate({
      dcmjs,
      positionals: [FIXTURE],
      values: { conformance: true },
      stdout: out.write,
      stderr: err.write,
    });
    expect(code).toBe(1);
    const text = err.lines.join("\n");
    expect(text).toMatch(/@dcmjs-org\/validator/);
    expect(text).toMatch(/without --conformance/);
  }
);
