// test/utils/extractTagKeyedJson.test.js

import { extractTagKeyedJson } from "../../src/utils/extractTagKeyedJson.js";

const MODALITY = { vr: "CS", Value: ["MR"] };
const PATIENT_NAME = { vr: "PN", Value: [{ Alphabetic: "DOE^JANE" }] };
const TRANSFER_SYNTAX = { vr: "UI", Value: ["1.2.840.10008.1.2.1"] };

test("flat DICOM JSON passes through", () => {
  const { tags, meta, ignoredKeys } = extractTagKeyedJson({
    "00080060": MODALITY,
    "00100010": PATIENT_NAME,
  });
  expect(tags["00080060"]).toBe(MODALITY);
  expect(tags["00100010"]).toBe(PATIENT_NAME);
  expect(meta).toEqual({});
  expect(ignoredKeys).toEqual([]);
});

test("wrapper objects are walked without naming their schema", () => {
  const { tags, meta, ignoredKeys } = extractTagKeyedJson({
    png: "001.png",
    provenance: { source_dicom: "somewhere", png_is_lossy_8bit: true },
    FileMetaInformation: { "00020010": TRANSFER_SYNTAX },
    dataset: { "00080060": MODALITY },
  });
  expect(tags["00080060"]).toBe(MODALITY);
  expect(meta["00020010"]).toBe(TRANSFER_SYNTAX); // group 0002 segregated
  expect(ignoredKeys).toContain("png");
  expect(ignoredKeys).toContain("provenance");
});

test("lowercase tag keys are normalized to uppercase", () => {
  const { tags } = extractTagKeyedJson({
    "0008103e": { vr: "LO", Value: ["COR 3D T1"] },
  });
  expect(tags["0008103E"]).toBeDefined();
});

test("shallowest occurrence of a tag wins", () => {
  const shallow = { vr: "CS", Value: ["MR"] };
  const deep = { vr: "CS", Value: ["CT"] };
  const { tags } = extractTagKeyedJson({
    "00080060": shallow,
    nested: { "00080060": deep },
  });
  expect(tags["00080060"]).toBe(shallow);
});

test("SQ item contents are not flattened out of their sequence", () => {
  const sequence = {
    vr: "SQ",
    Value: [{ "00080100": { vr: "SH", Value: ["CODE"] } }],
  };
  const { tags } = extractTagKeyedJson({ "00081032": sequence });
  expect(tags["00081032"]).toBe(sequence);
  expect(tags["00080100"]).toBeUndefined();
});

test("eight-hex keys without a vr are not tag entries", () => {
  const { tags, ignoredKeys } = extractTagKeyedJson({
    12345678: { note: "looks like a tag, is not DICOM JSON" },
  });
  expect(Object.keys(tags)).toHaveLength(0);
  expect(ignoredKeys).toContain("12345678");
});
