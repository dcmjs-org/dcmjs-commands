// test/utils/vrValue.test.js

import { getVr } from "../../src/utils/getVr.js";
import { getValue } from "../../src/utils/getValue.js";
import { fixValue } from "../../src/utils/fixValue.js";

describe("getVr", () => {
  test("uses the dictionary for known tags", () => {
    expect(getVr("00100010", {})).toBe("PN");
    expect(getVr("00080060", {})).toBe("CS");
  });

  test("guesses FL for unknown numeric values", () => {
    expect(getVr("99990001", { Value: [1.5] })).toBe("FL");
  });

  test("guesses UT for unknown string values", () => {
    expect(getVr("99990001", { Value: ["text"] })).toBe("UT");
  });

  test("falls back to UN with no value", () => {
    expect(getVr("99990001", {})).toBe("UN");
  });
});

describe("getValue", () => {
  test("unwraps single-value arrays", () => {
    expect(getValue({ "00080060": { Value: ["MR"] } }, "00080060")).toBe("MR");
  });

  test("returns empty string for zero-length values", () => {
    expect(getValue({ t: { Value: [] } }, "t")).toBe("");
  });

  test("returns the array for multi-values", () => {
    expect(getValue({ t: { Value: ["a", "b"] } }, "t")).toEqual(["a", "b"]);
  });

  test("returns undefined for missing tags", () => {
    expect(getValue({}, "nope")).toBeUndefined();
  });
});

describe("fixValue", () => {
  test("splits backslash-packed CS values in place", () => {
    const value = { vr: "CS", Value: ["ORIGINAL\\PRIMARY"] };
    fixValue(value);
    expect(value.Value).toEqual(["ORIGINAL", "PRIMARY"]);
  });

  test("leaves other VRs and empty values alone", () => {
    const lo = { vr: "LO", Value: ["a\\b"] };
    fixValue(lo);
    expect(lo.Value).toEqual(["a\\b"]);
    expect(() => fixValue({})).not.toThrow();
  });
});
