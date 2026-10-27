// test/dimsejs.test.js — the bin is an honest experimental stub

import { execFile } from "child_process";
import path from "path";
import { fileURLToPath } from "node:url";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, "..", "bin", "dimsejs.js");

test("dimsejs study exits 2 with an experimental notice", async () => {
  let code = 0;
  let stderr = "";
  try {
    await execFileAsync(process.execPath, [BIN, "study", "SOME_AE"]);
  } catch (err) {
    code = err.code;
    stderr = err.stderr;
  }
  expect(code).toBe(2);
  expect(stderr).toMatch(/experimental/i);
  expect(stderr).toMatch(/not implemented/i);
});

test("dimsejs --help exits 0", async () => {
  const { stdout } = await execFileAsync(process.execPath, [BIN, "--help"]);
  expect(stdout).toMatch(/dimse/i);
});
