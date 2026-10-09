// src/smart/imagingStudy.js
//
// The IG's finding-studies step: search the imaging FHIR endpoint for the
// patient's ImagingStudy resources with their Endpoints included, then
// resolve each study's WADO-RS base. The spec requires servers to support
// `_include=ImagingStudy:endpoint`, but the Endpoint can come back three
// ways — a Bundle entry (matched by fullUrl or relative reference), a
// contained resource (`#id`), or an absolute fullUrl — so resolution
// tries all three.

import { stripTrailingSlash } from "./discovery.js";

const WADO_RS_CONNECTION_CODE = "dicom-wado-rs";

/** `_lastUpdated` takes a FHIR search prefix; a bare date means "since". */
const FHIR_DATE_PREFIX = /^(eq|ne|gt|ge|lt|le|sa|eb|ap)/;

/**
 * Build the ImagingStudy search path per the IG:
 * `ImagingStudy?patient=<id>&_include=ImagingStudy:endpoint` plus the
 * optional `_lastUpdated` and `identifier` (StudyInstanceUID as
 * `urn:oid:<uid>`) narrowers.
 */
export function buildImagingStudyQuery({ patient, lastUpdated, studyUid }) {
  const params = new URLSearchParams();
  params.set("patient", patient);
  if (lastUpdated) {
    params.set(
      "_lastUpdated",
      FHIR_DATE_PREFIX.test(lastUpdated) ? lastUpdated : `gt${lastUpdated}`
    );
  }
  if (studyUid) {
    const value = studyUid.startsWith("urn:oid:")
      ? studyUid
      : `urn:oid:${studyUid}`;
    params.set("identifier", value);
  }
  params.set("_include", "ImagingStudy:endpoint");
  return `/ImagingStudy?${params.toString()}`;
}

/**
 * The DICOM StudyInstanceUID of an ImagingStudy: the identifier with
 * system `urn:dicom:uid` (value `urn:oid:<uid>`), falling back to any
 * identifier value, with the urn:oid: prefix stripped.
 */
export function extractStudyInstanceUID(study) {
  const identifiers = study?.identifier ?? [];
  const preferred =
    identifiers.find((id) => id?.system === "urn:dicom:uid") ??
    identifiers.find((id) => typeof id?.value === "string");
  const value = preferred?.value;
  if (!value) {
    return undefined;
  }
  return value.replace(/^urn:oid:/, "");
}

function endpointFromBundle(bundle, reference) {
  const entries = bundle?.entry ?? [];
  // Shape: absolute reference matching an entry fullUrl exactly
  for (const entry of entries) {
    if (entry.fullUrl && entry.fullUrl === reference) {
      return entry.resource;
    }
  }
  // Shape: relative reference (Endpoint/<id>) — match resource type/id,
  // or a fullUrl that ends with the reference
  const parts = reference.split("/");
  const [type, id] = parts.slice(-2);
  for (const entry of entries) {
    const resource = entry.resource;
    if (resource?.resourceType === type && resource?.id === id) {
      return resource;
    }
    if (entry.fullUrl?.endsWith(`/${type}/${id}`)) {
      return resource;
    }
  }
  return undefined;
}

function isWadoRs(endpoint) {
  const ct = endpoint.connectionType;
  if (!ct) {
    return false;
  }
  if (ct.code === WADO_RS_CONNECTION_CODE) {
    return true;
  }
  return (ct.coding ?? []).some((c) => c?.code === WADO_RS_CONNECTION_CODE);
}

/**
 * Resolve a study's Endpoint resource from the search Bundle.
 * Prefers a dicom-wado-rs connectionType when several resolve.
 * @returns {Object} the FHIR Endpoint resource (with .address)
 * @throws when no referenced Endpoint with an address can be resolved
 */
export function resolveEndpoint(bundle, study) {
  const candidates = [];
  for (const ref of study?.endpoint ?? []) {
    const reference = ref?.reference;
    if (!reference) {
      continue;
    }
    let resource;
    if (reference.startsWith("#")) {
      // Shape: contained resource
      resource = (study.contained ?? []).find(
        (c) => c?.id === reference.slice(1)
      );
    } else {
      resource = endpointFromBundle(bundle, reference);
    }
    if (resource?.resourceType === "Endpoint" && resource.address) {
      candidates.push(resource);
    }
  }
  const chosen = candidates.find(isWadoRs) ?? candidates[0];
  if (!chosen) {
    const label = study?.id ? `ImagingStudy/${study.id}` : "an ImagingStudy";
    throw new Error(
      `${label} came back without a resolvable Endpoint (no contained ` +
        `resource, Bundle entry, or absolute reference matched) — ` +
        `without Endpoint.address there is no WADO-RS base to retrieve ` +
        `from; the imaging server did not honor ` +
        `_include=ImagingStudy:endpoint, so report it or try another ` +
        `--imaging-url`
    );
  }
  return chosen;
}

/**
 * Search the imaging endpoint for the patient's studies and resolve each
 * one's WADO-RS base.
 * @returns {Promise<{url, bundle, studies: Array<{study, wadoBase,
 *   studyInstanceUID}>}>}
 */
export async function searchImagingStudies({
  imagingBase,
  token,
  patient,
  lastUpdated,
  studyUid,
  fetchFn,
}) {
  const doFetch = fetchFn ?? globalThis.fetch;
  const url =
    stripTrailingSlash(imagingBase) +
    buildImagingStudyQuery({ patient, lastUpdated, studyUid });
  const headers = { Accept: "application/fhir+json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await doFetch(url, { headers });
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `the imaging server at ${imagingBase} rejected the request with ` +
        `HTTP ${response.status} — the token does not grant ` +
        `patient/ImagingStudy access there; re-run the authorization ` +
        `(tokens expire), or check --scope and that --imaging-url ` +
        `belongs to the same trust network as --fhir-url`
    );
  }
  if (!response.ok) {
    throw new Error(
      `ImagingStudy search ${url} failed with HTTP ${response.status} — ` +
        `no study list means nothing to retrieve; check --imaging-url ` +
        `and --patient`
    );
  }
  const bundle = await response.json();
  if (bundle?.resourceType !== "Bundle") {
    throw new Error(
      `${url} answered with ${bundle?.resourceType ?? "no resourceType"} ` +
        `instead of a Bundle — this does not look like a FHIR search ` +
        `endpoint; check --imaging-url points at the imaging FHIR base ` +
        `(not the WADO-RS root)`
    );
  }

  const studies = [];
  for (const entry of bundle.entry ?? []) {
    const study = entry?.resource;
    if (study?.resourceType !== "ImagingStudy") {
      continue; // included Endpoints, OperationOutcomes, ...
    }
    const endpoint = resolveEndpoint(bundle, study);
    const studyInstanceUID = extractStudyInstanceUID(study);
    if (!studyInstanceUID) {
      const label = study.id ? `ImagingStudy/${study.id}` : "an ImagingStudy";
      throw new Error(
        `${label} carries no identifier to derive a StudyInstanceUID ` +
          `from — WADO-RS retrieval is addressed by study UID, so this ` +
          `study cannot be fetched; the imaging server should populate ` +
          `identifier with system urn:dicom:uid`
      );
    }
    studies.push({
      study,
      studyInstanceUID,
      wadoBase: stripTrailingSlash(endpoint.address),
    });
  }
  return { url, bundle, studies };
}
