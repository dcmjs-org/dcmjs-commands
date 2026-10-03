// test/publishFhir.test.js
//
// The dicomweb+fhir output format: buildFhirLayer unit behavior (id
// grafting, references, bundle semantics, consistency warnings) and the
// end-to-end `dcmjs dicomweb --fhir` flow against a real fixture tree.
// Test identity: JANE DOE (maiden) → JANE FOX (official).

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  buildFhirLayer,
  toTransactionBundle,
} from "../src/fhir/publishFhir.js";
import { runDicomweb } from "../src/commands/dicomweb.js";

const require = createRequire(import.meta.url);
const dcmjs = require("dcmjs");
dcmjs.log.setLevel("silent");

const { DicomMessage } = dcmjs.data;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "sample-dicom.dcm");

const STUDY_UID = "2.25.888";

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

function natural(overrides = {}) {
  return {
    StudyInstanceUID: STUDY_UID,
    SeriesInstanceUID: "2.25.888.1",
    SOPInstanceUID: "2.25.888.1.1",
    SOPClassUID: "1.2.840.10008.5.1.4.1.1.4",
    Modality: "MR",
    PatientID: "22446688",
    PatientName: [{ Alphabetic: "FOX^JANE" }],
    StudyDescription: "HEAD^BRAIN",
    ...overrides,
  };
}

describe("buildFhirLayer", () => {
  test("derives the Patient from tags when no resource is provided", () => {
    const layer = buildFhirLayer({ naturals: [natural()] });
    expect(layer.patient.resourceType).toBe("Patient");
    expect(layer.patient.id).toBe("22446688");
    expect(layer.patient.name[0].family).toBe("FOX");
    expect(layer.warnings).toEqual([]);
  });

  test("provided Patient is embedded verbatim with an assigned id", () => {
    const layer = buildFhirLayer({
      naturals: [natural()],
      patientResource: JANE_FOX,
    });
    expect(layer.patient.name).toEqual(JANE_FOX.name);
    expect(layer.patient.id).toBe("22446688");
    expect(layer.warnings).toEqual([]);
  });

  test("provided Patient disagreeing with tags warns but proceeds", () => {
    const layer = buildFhirLayer({
      naturals: [
        natural({
          PatientID: "998877",
          PatientName: [{ Alphabetic: "DOE^JANE" }],
        }),
      ],
      patientResource: JANE_FOX,
    });
    expect(layer.patient.id).toBe("22446688"); // resource is authoritative
    expect(layer.warnings.join("\n")).toMatch(/does not match/);
    expect(layer.warnings.join("\n")).toMatch(/filter --fhir-patient/);
  });

  test("ImagingStudy gets id, subject, and endpoint grafts", () => {
    const layer = buildFhirLayer({
      naturals: [natural(), natural({ SOPInstanceUID: "2.25.888.1.2" })],
      patientResource: JANE_FOX,
    });
    const study = layer.imagingStudy;
    expect(study.id).toBe(STUDY_UID);
    expect(study.subject.reference).toBe("Patient/22446688");
    expect(study.subject.display).toContain("JANE");
    expect(study.endpoint).toEqual([{ reference: "Endpoint/dicomweb" }]);
    expect(study.numberOfInstances).toBe(2);
    expect(study.identifier[0].value).toBe(`urn:oid:${STUDY_UID}`);
  });

  test("Endpoint default address, overridable via wadoRoot", () => {
    const defaulted = buildFhirLayer({ naturals: [natural()] });
    expect(defaulted.endpoint.address).toBe("http://localhost:5000/dicomweb");
    expect(defaulted.endpoint.connectionType.code).toBe("dicom-wado-rs");

    const custom = buildFhirLayer({
      naturals: [natural()],
      wadoRoot: "https://pacs.example.org/dicomweb",
    });
    expect(custom.endpoint.address).toBe("https://pacs.example.org/dicomweb");
  });

  test("Encounter is embedded, referenced, and subject-linked", () => {
    const layer = buildFhirLayer({
      naturals: [natural()],
      patientResource: JANE_FOX,
      encounterResource: {
        resourceType: "Encounter",
        status: "finished",
        identifier: [{ value: "VISIT-77" }],
      },
    });
    expect(layer.encounter.id).toBe("VISIT-77");
    expect(layer.encounter.subject.reference).toBe("Patient/22446688");
    expect(layer.imagingStudy.encounter.reference).toBe("Encounter/VISIT-77");
  });

  test("empty study is a corrective error", () => {
    expect(() => buildFhirLayer({ naturals: [] })).toThrow(
      /no instance datasets/
    );
  });
});

describe("toTransactionBundle", () => {
  test("every entry is an idempotent PUT with matching url", () => {
    const layer = buildFhirLayer({
      naturals: [natural()],
      patientResource: JANE_FOX,
    });
    const bundle = toTransactionBundle([
      layer.patient,
      layer.imagingStudy,
      layer.endpoint,
    ]);
    expect(bundle.type).toBe("transaction");
    expect(bundle.entry).toHaveLength(3);
    for (const entry of bundle.entry) {
      const expected = `${entry.resource.resourceType}/${entry.resource.id}`;
      expect(entry.request).toEqual({ method: "PUT", url: expected });
      expect(entry.fullUrl).toBe(expected);
    }
  });
});

describe("dcmjs dicomweb --fhir end to end", () => {
  let dir;

  function writeInstance(filePath, { sopUid, seriesUid }) {
    const buffer = fs.readFileSync(FIXTURE);
    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    );
    const dicomDict = DicomMessage.readFile(arrayBuffer);
    dicomDict.upsertTag("0020000D", "UI", [STUDY_UID]);
    dicomDict.upsertTag("00080018", "UI", [sopUid]);
    dicomDict.upsertTag("0020000E", "UI", [seriesUid]);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(dicomDict.write()));
  }

  function capture() {
    const lines = [];
    return { write: (text) => lines.push(text), lines };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "webfhir-"));
    writeInstance(path.join(dir, "src", "IM000001"), {
      sopUid: "2.25.888.1.1",
      seriesUid: "2.25.888.1",
    });
    writeInstance(path.join(dir, "src", "IM000002"), {
      sopUid: "2.25.888.1.2",
      seriesUid: "2.25.888.1",
    });
    writeInstance(path.join(dir, "src", "IM000003"), {
      sopUid: "2.25.888.2.1",
      seriesUid: "2.25.888.2",
    });
    fs.writeFileSync(path.join(dir, "jane-fox.json"), JSON.stringify(JANE_FOX));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("writes the full fhir/ layer alongside the dicomweb tree", async () => {
    const dest = path.join(dir, "web");
    const out = capture();
    const err = capture();
    const code = await runDicomweb({
      dcmjs,
      positionals: [path.join(dir, "src")],
      values: {
        directory: dest,
        fhir: true,
        "fhir-patient": path.join(dir, "jane-fox.json"),
        "wado-root": "https://pacs.example.org/dicomweb",
      },
      stdout: out.write,
      stderr: err.write,
    });
    expect(code).toBe(0);
    expect(out.lines.join("\n")).toMatch(/fhir: Patient\/22446688/);

    // dicomweb side still present
    expect(
      fs.existsSync(path.join(dest, "studies", STUDY_UID, "index.json.gz"))
    ).toBe(true);

    // fhir side
    const read = (p) =>
      JSON.parse(fs.readFileSync(path.join(dest, "fhir", p), "utf8"));
    const patient = read("Patient/22446688.json");
    expect(patient.name[0].family).toBe("FOX");

    const study = read(`ImagingStudy/${STUDY_UID}.json`);
    expect(study.numberOfSeries).toBe(2);
    expect(study.numberOfInstances).toBe(3);
    expect(study.subject.reference).toBe("Patient/22446688");
    expect(study.endpoint[0].reference).toBe("Endpoint/dicomweb");

    const endpoint = read("Endpoint/dicomweb.json");
    expect(endpoint.address).toBe("https://pacs.example.org/dicomweb");

    const bundle = read("Bundle.json");
    expect(bundle.type).toBe("transaction");
    const urls = bundle.entry.map((e) => e.request.url).sort();
    expect(urls).toEqual([
      "Endpoint/dicomweb",
      `ImagingStudy/${STUDY_UID}`,
      "Patient/22446688",
    ]);
  });

  test("--fhir alone derives the Patient from the instance tags", async () => {
    const dest = path.join(dir, "web");
    const out = capture();
    const code = await runDicomweb({
      dcmjs,
      positionals: [path.join(dir, "src")],
      values: { directory: dest, fhir: true },
      stdout: out.write,
      stderr: capture().write,
    });
    expect(code).toBe(0);
    const files = fs.readdirSync(path.join(dest, "fhir", "Patient"));
    expect(files).toHaveLength(1); // derived from whatever the fixture carries
    expect(fs.existsSync(path.join(dest, "fhir", "Bundle.json"))).toBe(true);
  });
});
