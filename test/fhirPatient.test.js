// test/fhirPatient.test.js
//
// --fhir-patient end to end: a FHIR Patient resource applied to real DICOM
// streams via filter (insert-or-replace in the event stream) and convert
// (dict rewrite / image build). Test identity: JANE DOE (maiden) → JANE FOX
// (official). The load-bearing case is insertion — files whose patient tags
// were REMOVED (de-identified) must still receive the full module, in tag
// order, at the top level only.

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { runFilter } from "../src/commands/filter.js";
import { runConvert } from "../src/commands/convert.js";

const require = createRequire(import.meta.url);
const dcmjs = require("dcmjs");
dcmjs.log.setLevel("silent");

const { DicomMessage, DicomMetaDictionary } = dcmjs.data;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "sample-dicom.dcm");

const JANE_FOX = {
  resourceType: "Patient",
  identifier: [{ type: { coding: [{ code: "MR" }] }, value: "22446688" }],
  name: [
    { use: "official", family: "FOX", given: ["JANE"] },
    { use: "maiden", family: "DOE", given: ["JANE"] },
  ],
  gender: "female",
  birthDate: "1980-04-15",
};

let dir;
let patientPath;

function capture() {
  const lines = [];
  return { write: (text) => lines.push(text), lines };
}

async function run(fn, positionals, values) {
  const out = capture();
  const err = capture();
  const code = await fn({
    dcmjs,
    positionals,
    values,
    stdout: out.write,
    stderr: err.write,
  });
  return { code, out: out.lines, err: err.lines };
}

function readDataset(filePath) {
  const buffer = fs.readFileSync(filePath);
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
  return DicomMetaDictionary.naturalizeDataset(
    DicomMessage.readFile(arrayBuffer).dict
  );
}

function expectJaneFox(dataset) {
  expect(String(dataset.PatientName)).toBe("FOX^JANE");
  expect(dataset.PatientID).toBe("22446688");
  expect(dataset.PatientBirthDate).toBe("19800415");
  expect(dataset.PatientSex).toBe("F");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fhir-patient-"));
  patientPath = path.join(dir, "jane-fox.json");
  fs.writeFileSync(patientPath, JSON.stringify(JANE_FOX));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("filter --fhir-patient", () => {
  test("replaces an existing patient module in the stream", async () => {
    const outPath = path.join(dir, "renamed.dcm");
    const { code } = await run(runFilter, [FIXTURE], {
      output: outPath,
      "fhir-patient": patientPath,
    });
    expect(code).toBe(0);
    expectJaneFox(readDataset(outPath));
  });

  test("INSERTS the module into a file whose patient tags were dropped", async () => {
    // De-identify first: strip all four patient-module tags outright.
    const stripped = path.join(dir, "deid.dcm");
    await run(runFilter, [FIXTURE], {
      output: stripped,
      drop: ["00100010", "00100020", "00100030", "00100040"],
    });
    const deid = readDataset(stripped);
    expect(deid.PatientName).toBeUndefined();
    expect(deid.PatientID).toBeUndefined();

    // Injection must create the elements, not just replace.
    const outPath = path.join(dir, "reidentified.dcm");
    const { code } = await run(runFilter, [stripped], {
      output: outPath,
      "fhir-patient": patientPath,
    });
    expect(code).toBe(0);
    expectJaneFox(readDataset(outPath));
  });

  test("deterministic overwrite: resource without birthDate clears the tag", async () => {
    const partial = path.join(dir, "partial.json");
    fs.writeFileSync(
      partial,
      JSON.stringify({
        resourceType: "Patient",
        name: [{ use: "official", family: "FOX", given: ["JANE"] }],
      })
    );
    const outPath = path.join(dir, "cleared.dcm");
    const { code } = await run(runFilter, [FIXTURE], {
      output: outPath,
      "fhir-patient": partial,
    });
    expect(code).toBe(0);
    const dataset = readDataset(outPath);
    expect(String(dataset.PatientName)).toBe("FOX^JANE");
    // present-but-empty, not carrying the fixture's previous values
    expect(dataset.PatientID ?? "").toBe("");
    expect(dataset.PatientBirthDate ?? "").toBe("");
    expect(dataset.PatientSex ?? "").toBe("");
  });

  test("composes with --set/--drop (fhir filter runs last)", async () => {
    const outPath = path.join(dir, "combo.dcm");
    const { code } = await run(runFilter, [FIXTURE], {
      output: outPath,
      set: ["00080050=ACC42"],
      "fhir-patient": patientPath,
    });
    expect(code).toBe(0);
    const dataset = readDataset(outPath);
    expect(dataset.AccessionNumber).toBe("ACC42");
    expectJaneFox(dataset);
  });

  test("unreadable resource is a corrective error", async () => {
    fs.writeFileSync(patientPath, "{not json");
    const { code, err } = await run(runFilter, [FIXTURE], {
      output: path.join(dir, "x.dcm"),
      "fhir-patient": patientPath,
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/could not read FHIR Patient/);
  });

  test("non-Patient resource is rejected with the resourceType named", async () => {
    fs.writeFileSync(
      patientPath,
      JSON.stringify({ resourceType: "Observation" })
    );
    const { code, err } = await run(runFilter, [FIXTURE], {
      output: path.join(dir, "x.dcm"),
      "fhir-patient": patientPath,
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/Observation/);
  });
});

describe("convert --fhir-patient", () => {
  test("dcm → dcm applies the demographics", async () => {
    const outPath = path.join(dir, "converted.dcm");
    const { code } = await run(runConvert, [FIXTURE], {
      to: "dcm",
      output: outPath,
      "fhir-patient": patientPath,
    });
    expect(code).toBe(0);
    expectJaneFox(readDataset(outPath));
  });

  test("dcm → fhir round-trips the identity", async () => {
    const { code, out } = await run(runConvert, [FIXTURE], {
      to: "fhir",
      "fhir-patient": patientPath,
    });
    expect(code).toBe(0);
    const { patient } = JSON.parse(out.join(""));
    expect(patient.name[0].family).toBe("FOX");
    expect(patient.identifier[0].value).toBe("22446688");
    expect(patient.gender).toBe("female");
  });
});
