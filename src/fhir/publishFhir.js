// src/fhir/publishFhir.js
//
// The FHIR layer of the dicomweb+fhir output format — the SMART-imaging
// pattern: FHIR resources for discovery and identity, the DICOMweb tree for
// pixels. Assembly happens here (not in a chain filter) because an
// ImagingStudy aggregates a whole study; stream filters see one file at a
// time.
//
// The dcmjs fhir mappers deliberately emit standard resources with no ids,
// references, or endpoints ("deployment-specific decoration is the
// consumer's job") — this module is that consumer: it assigns deterministic
// ids, wires subject/endpoint/encounter references, and packages everything
// as a transaction Bundle a FHIR server can swallow in one POST.

import fs from "node:fs";
import path from "node:path";
import dcmjs from "../dcmjsBundle.js";

const { patientFromDataset, imagingStudyFromDatasets } = dcmjs.fhir;

// REMINDER (confer with coworkers before this ships anywhere real):
// the Endpoint.address default below matches static-wado-webserver's
// default port, but the right long-term story — rewrite-on-deploy? a
// placeholder scheme? per-environment config? — is an open team question.
const DEFAULT_WADO_ROOT = "http://localhost:5000/dicomweb";

const ENDPOINT_ID = "dicomweb";

/** Sanitize a string to FHIR id chars (A-Za-z0-9-.), max 64. */
function toFhirId(value, fallback) {
  const cleaned = String(value ?? "")
    .replace(/[^A-Za-z0-9\-.]/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .substring(0, 64);
  return cleaned || fallback;
}

function readResource(filePath, expectedType) {
  let resource;
  try {
    resource = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`could not read FHIR resource ${filePath}: ${err.message}`);
  }
  if (resource.resourceType !== expectedType) {
    throw new Error(
      `${filePath} is a ${resource.resourceType}, expected ${expectedType}`
    );
  }
  return resource;
}

export function loadPatientResource(filePath) {
  return readResource(filePath, "Patient");
}

export function loadEncounterResource(filePath) {
  return readResource(filePath, "Encounter");
}

/**
 * Collect naturalized instance datasets from a source study access — the
 * input imagingStudyFromDatasets wants. Works for any source whose
 * childrenMap is populated (i.e. after a store() walk): series → instances
 * → getNatural().
 */
export function collectStudyNaturals(srcStudy) {
  const naturals = [];
  for (const series of srcStudy.childrenMap.values()) {
    for (const instance of series.childrenMap.values()) {
      naturals.push(instance.getNatural());
    }
  }
  return naturals;
}

function patientDisplay(patient) {
  const name = patient?.name?.[0];
  if (!name) {
    return undefined;
  }
  return (
    name.text ||
    [name.given?.join(" "), name.family].filter(Boolean).join(" ") ||
    undefined
  );
}

/** Naturalized PN → plain string ([{Alphabetic}], {Alphabetic}, or string). */
function pnToString(value) {
  const first = Array.isArray(value) ? value[0] : value;
  if (!first) {
    return "";
  }
  return String(first.Alphabetic ?? first);
}

/** Compare a provided Patient against the instance tags; return warnings. */
function checkPatientConsistency(patient, representative) {
  const warnings = [];
  const attrs = dcmjs.fhir.patientToDataset(patient);
  const tagId = representative.PatientID;
  const tagName = pnToString(representative.PatientName);
  if (tagId && attrs.PatientID && tagId !== attrs.PatientID) {
    warnings.push(
      `provided Patient identifier ${attrs.PatientID} does not match the ` +
        `instances' PatientID ${tagId} — the FHIR layer uses the provided ` +
        `resource; run dcmjs filter --fhir-patient first if the instances ` +
        `should match`
    );
  }
  if (tagName && attrs.PatientName && tagName !== attrs.PatientName) {
    warnings.push(
      `provided Patient name ${attrs.PatientName} does not match the ` +
        `instances' PatientName ${tagName} — the FHIR layer uses the ` +
        `provided resource`
    );
  }
  return warnings;
}

/**
 * Build the FHIR layer for one study.
 *
 * @param {Object} args
 * @param {Object[]} args.naturals - naturalized instance datasets (one study)
 * @param {Object} [args.patientResource] - provided FHIR Patient (verbatim,
 *   authoritative for the FHIR layer; consistency vs tags is warned on)
 * @param {Object} [args.encounterResource] - provided FHIR Encounter
 *   (embedded and referenced; deliberately NOT mapped onto DICOM tags —
 *   that mapping is an open team question)
 * @param {string} [args.wadoRoot] - Endpoint.address
 * @returns {{ patient, imagingStudy, endpoint, encounter, warnings }}
 */
export function buildFhirLayer({
  naturals,
  patientResource,
  encounterResource,
  wadoRoot = DEFAULT_WADO_ROOT,
}) {
  if (!naturals?.length) {
    throw new Error("buildFhirLayer: no instance datasets for the study");
  }
  const representative = naturals[0];
  const warnings = [];

  let patient;
  if (patientResource) {
    patient = structuredClone(patientResource);
    warnings.push(...checkPatientConsistency(patient, representative));
  } else {
    patient = patientFromDataset(representative) || {
      resourceType: "Patient",
    };
  }
  if (!patient.id) {
    patient.id = toFhirId(
      patient.identifier?.[0]?.value ?? representative.PatientID,
      "unidentified-patient"
    );
  }

  let encounter = null;
  if (encounterResource) {
    encounter = structuredClone(encounterResource);
    if (!encounter.id) {
      encounter.id = toFhirId(encounter.identifier?.[0]?.value, "encounter-1");
    }
    if (!encounter.subject) {
      encounter.subject = { reference: `Patient/${patient.id}` };
    }
  }

  const imagingStudy = imagingStudyFromDatasets(naturals, {
    subject: {
      reference: `Patient/${patient.id}`,
      ...(patientDisplay(patient) ? { display: patientDisplay(patient) } : {}),
    },
  });
  if (!imagingStudy) {
    throw new Error(
      "buildFhirLayer: instances carry no imaging identity — cannot build an ImagingStudy"
    );
  }
  imagingStudy.id = toFhirId(
    representative.StudyInstanceUID,
    "imaging-study-1"
  );
  imagingStudy.endpoint = [{ reference: `Endpoint/${ENDPOINT_ID}` }];
  if (encounter) {
    imagingStudy.encounter = { reference: `Encounter/${encounter.id}` };
  }

  const endpoint = {
    resourceType: "Endpoint",
    id: ENDPOINT_ID,
    status: "active",
    connectionType: {
      system: "http://terminology.hl7.org/CodeSystem/endpoint-connection-type",
      code: "dicom-wado-rs",
      display: "DICOM WADO-RS",
    },
    payloadType: [
      {
        coding: [
          {
            system:
              "http://terminology.hl7.org/CodeSystem/endpoint-payload-type",
            code: "any",
          },
        ],
      },
    ],
    address: wadoRoot,
  };

  return { patient, imagingStudy, endpoint, encounter, warnings };
}

/** Transaction Bundle (idempotent PUT upserts) over a set of resources. */
export function toTransactionBundle(resources) {
  return {
    resourceType: "Bundle",
    type: "transaction",
    entry: resources.filter(Boolean).map((resource) => ({
      fullUrl: `${resource.resourceType}/${resource.id}`,
      resource,
      request: {
        method: "PUT",
        url: `${resource.resourceType}/${resource.id}`,
      },
    })),
  };
}

/**
 * Write one study's FHIR layer under <destDir>/fhir. Pretty-printed, not
 * gzipped — humans and FHIR servers read these; the gz convention belongs
 * to the dicomweb side. Multi-study runs accumulate: resource files are
 * deduped by path, and Bundle.json is rebuilt from every resource file
 * present so it always covers the whole tree.
 */
export function writeFhirLayer(destDir, layer) {
  const fhirDir = path.join(destDir, "fhir");
  const { patient, imagingStudy, endpoint, encounter } = layer;

  const writeResource = (resource) => {
    const dir = path.join(fhirDir, resource.resourceType);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${resource.id}.json`),
      JSON.stringify(resource, null, 2) + "\n"
    );
  };
  for (const resource of [patient, imagingStudy, endpoint, encounter]) {
    if (resource) {
      writeResource(resource);
    }
  }

  // Rebuild the Bundle from everything on disk (covers multi-study runs).
  const all = [];
  for (const typeDir of fs.readdirSync(fhirDir).sort()) {
    const typePath = path.join(fhirDir, typeDir);
    if (!fs.statSync(typePath).isDirectory()) {
      continue;
    }
    for (const file of fs.readdirSync(typePath).sort()) {
      if (file.endsWith(".json")) {
        all.push(
          JSON.parse(fs.readFileSync(path.join(typePath, file), "utf8"))
        );
      }
    }
  }
  fs.writeFileSync(
    path.join(fhirDir, "Bundle.json"),
    JSON.stringify(toTransactionBundle(all), null, 2) + "\n"
  );

  return fhirDir;
}
