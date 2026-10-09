// test/utils/setOptions.test.js
//
// The log-level ladder: quiet-by-default (the per-instance transfer
// narration is info-level and must be opt-in), with --verbose restoring
// the old info default.

import loglevel from "loglevel";
import { setOptions } from "../../src/utils/logger.js";

const level = () => loglevel.getLevel();
const LEVELS = loglevel.levels; // { TRACE:0, DEBUG:1, INFO:2, WARN:3, ERROR:4 }

afterAll(() => {
  loglevel.setLevel("warn");
  loglevel.rebuild();
});

test("default is warn — no narration on the happy path", () => {
  setOptions({});
  expect(level()).toBe(LEVELS.WARN);
});

test("--verbose restores info", () => {
  setOptions({ verbose: true });
  expect(level()).toBe(LEVELS.INFO);
});

test("--debug wins over --verbose", () => {
  setOptions({ debug: true, verbose: true });
  expect(level()).toBe(LEVELS.DEBUG);
});

test("--quiet is errors only", () => {
  setOptions({ quiet: true });
  expect(level()).toBe(LEVELS.ERROR);
});

test("explicit loglevel wins over everything", () => {
  setOptions({ loglevel: "trace", debug: true, quiet: true });
  expect(level()).toBe(LEVELS.TRACE);
});
