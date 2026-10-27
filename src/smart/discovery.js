// src/smart/discovery.js
//
// SMART on FHIR discovery for the SMART Imaging Access IG
// (https://build.fhir.org/ig/argonautproject/smart-imaging/).
// A clinical FHIR server advertises its authorization endpoints — and,
// when it participates in an imaging network, the imaging FHIR endpoint —
// in /.well-known/smart-configuration. The imaging endpoint is either the
// server itself (top-level `capabilities` contains "smart-imaging-access")
// or an entry in `associated_endpoints` carrying that capability.

export const SMART_IMAGING_CAPABILITY = "smart-imaging-access";

/** Trailing slashes make `<base>/.well-known/...` a double-slash 401 on
 * some routers (Medplum), so bases are always normalized. */
export function stripTrailingSlash(url) {
  return String(url).replace(/\/+$/, "");
}

/**
 * GET `<base>/.well-known/smart-configuration`.
 * @returns {Promise<Object>} the parsed SMART configuration document
 */
export async function fetchSmartConfiguration(baseUrl, { fetchFn } = {}) {
  const doFetch = fetchFn ?? globalThis.fetch;
  const url = `${stripTrailingSlash(baseUrl)}/.well-known/smart-configuration`;

  let response;
  try {
    response = await doFetch(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    throw new Error(
      `could not reach ${url} (${err.message}) — without SMART discovery ` +
        `there is no authorization server or imaging endpoint to find; ` +
        `check --fhir-url, or skip discovery with --imaging-url plus --token`
    );
  }
  if (response.status === 404) {
    throw new Error(
      `${url} returned 404 — this server does not publish a SMART ` +
        `configuration, so the authorization server and imaging endpoint ` +
        `cannot be discovered; check --fhir-url, or skip discovery with ` +
        `--imaging-url plus --token`
    );
  }
  if (!response.ok) {
    throw new Error(
      `SMART discovery at ${url} failed with HTTP ${response.status} — ` +
        `the configuration document is required to continue; check ` +
        `--fhir-url, or skip discovery with --imaging-url plus --token`
    );
  }
  return response.json();
}

/**
 * Find the imaging FHIR endpoint a SMART configuration advertises.
 * @returns {string|null} the imaging base URL, or null when the server
 *   advertises no smart-imaging-access capability (caller falls back to an
 *   explicit --imaging-url).
 */
export function findImagingEndpoint(config, baseUrl) {
  for (const endpoint of config?.associated_endpoints ?? []) {
    if (
      endpoint?.url &&
      endpoint.capabilities?.includes(SMART_IMAGING_CAPABILITY)
    ) {
      return stripTrailingSlash(endpoint.url);
    }
  }
  if (config?.capabilities?.includes(SMART_IMAGING_CAPABILITY)) {
    return stripTrailingSlash(baseUrl);
  }
  return null;
}
