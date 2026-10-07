// src/commands/patientAccess.js
//
// dcmjs patient-access [options]
//
// The SMART Imaging Access IG (App Launch mode) end to end: discover the
// imaging endpoint from the clinical FHIR server's smart-configuration,
// authorize via SMART App Launch (public client + PKCE, loopback
// redirect), search ImagingStudy?patient=...&_include=ImagingStudy:endpoint,
// and retrieve each study over WADO-RS at the resolved Endpoint.address
// with the same Bearer token — into a Static-DICOMweb tree or Part 10
// files, reusing the `dicomwebjs download`/`part10` machinery.

import { spawn } from "node:child_process";
import { DicomAccess } from "../access/DicomAccess.js";
import {
  fetchSmartConfiguration,
  findImagingEndpoint,
} from "../smart/discovery.js";
import {
  DEFAULT_REDIRECT_PORT,
  REDIRECT_PATH,
  assertStateMatches,
  buildAuthorizationUrl,
  exchangeCodeForToken,
  generatePkce,
  generateState,
  promptForCode,
  runLoopbackListener,
} from "../smart/appLaunch.js";
import { searchImagingStudies } from "../smart/imagingStudy.js";
import {
  buildFhirLayer,
  writeFhirLayer,
  collectStudyNaturals,
} from "../fhir/publishFhir.js";

export const patientAccessUsage = `usage: dcmjs patient-access [options]

Fetch a patient's imaging studies via SMART Imaging Access: discover the
imaging endpoint from the clinical FHIR server, authorize (SMART App
Launch with PKCE), search ImagingStudy for the patient, and retrieve each
study over WADO-RS with the same Bearer token.

    --fhir-url <base>       clinical FHIR base (SMART discovery + authorization)
    --imaging-url <base>    imaging FHIR base (skips discovery)
    --patient <id>          FHIR Patient id (default: the token's launch
                            context patient)
    --token <bearer>        use this access token and skip authorization
    --client-id <id>        OAuth client id for SMART App Launch
    --redirect-port <n>     loopback port for the redirect URI
                            (default ${DEFAULT_REDIRECT_PORT}; URI is
                            http://127.0.0.1:<n>${REDIRECT_PATH})
    --paste-code            paste the authorization code by hand instead
                            of listening on the loopback
    --scope <scope>         OAuth scope (default: patient/ImagingStudy.rs)
    --last-updated <date>   only studies updated since this instant
                            (FHIR _lastUpdated; bare dates mean gt<date>)
    --study-uid <uid>       only the study with this StudyInstanceUID
    -o, --output <dir>      destination directory (required unless --dry-run)
    --format <fmt>          part10 | dicomweb (default: dicomweb, the
                            Static-DICOMweb tree)
    --fhir                  also write the FHIR layer under <output>/fhir
    --dry-run               stop after listing studies and endpoints
`;

const FORMATS = {
  dicomweb: () => DicomAccess.DICOMWEB_OPTIONS,
  part10: () => DicomAccess.PART10_OPTIONS,
};

/** Best-effort `open`/`xdg-open`; the printed URL is the real interface. */
function defaultOpenBrowser(url) {
  const bin = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawn(bin, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // printing the URL is enough
  }
}

/** Flag validation up front: every miss names the flag to add. */
function validateFlags(values) {
  const format = values.format || "dicomweb";
  if (!FORMATS[format]) {
    throw new Error(
      `unknown --format "${format}" — nothing would be written; use ` +
        `--format dicomweb (Static-DICOMweb tree) or --format part10`
    );
  }
  if (!values.output && !values["dry-run"]) {
    throw new Error(
      `no --output given — retrieved studies need a destination ` +
        `directory; add --output <dir>, or --dry-run to only list studies`
    );
  }
  if (!values["fhir-url"] && !values["imaging-url"]) {
    throw new Error(
      `no server given — there is nowhere to look for studies; add ` +
        `--fhir-url <base> (SMART discovery finds the imaging endpoint) ` +
        `or --imaging-url <base> directly`
    );
  }
  if (!values.token) {
    if (!values["fhir-url"]) {
      throw new Error(
        `--imaging-url without --token needs an authorization server, ` +
          `which only SMART discovery provides — add --fhir-url <base>, ` +
          `or supply a pre-authorized --token <bearer>`
      );
    }
    if (!values["client-id"]) {
      throw new Error(
        `no --client-id given — SMART App Launch cannot start without a ` +
          `registered OAuth client; add --client-id <id> (registered ` +
          `with redirect URI http://127.0.0.1:<port>${REDIRECT_PATH}), ` +
          `or skip authorization with --token <bearer>`
      );
    }
  } else if (!values.patient) {
    throw new Error(
      `--token skips authorization, so there is no launch context to ` +
        `supply the patient — add --patient <id>`
    );
  }
  const port = Number(values["redirect-port"] ?? DEFAULT_REDIRECT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `--redirect-port "${values["redirect-port"]}" is not a port — the ` +
        `loopback listener cannot start; pass a number between 1 and 65535`
    );
  }
  return { format, port };
}

/** The interactive App Launch leg; returns {token, patient}. */
async function authorize({
  values,
  config,
  fhirUrl,
  port,
  stdout,
  fetchFn,
  listen,
  prompt,
  openBrowser,
}) {
  const { authorization_endpoint, token_endpoint } = config;
  if (!authorization_endpoint || !token_endpoint) {
    throw new Error(
      `the SMART configuration at ${fhirUrl} lists no ` +
        `authorization_endpoint/token_endpoint — App Launch cannot run ` +
        `against it; use a SMART-enabled --fhir-url, or skip ` +
        `authorization with --token <bearer>`
    );
  }
  const { codeVerifier, codeChallenge } = generatePkce();
  const state = generateState();
  const redirectUri = `http://127.0.0.1:${port}${REDIRECT_PATH}`;
  const authUrl = buildAuthorizationUrl({
    authorizationEndpoint: authorization_endpoint,
    clientId: values["client-id"],
    redirectUri,
    scope: values.scope || "patient/ImagingStudy.rs",
    state,
    codeChallenge,
    aud: fhirUrl,
  });

  stdout(`patient-access: open this URL in a browser to authorize:`);
  stdout(`  ${authUrl}`);
  openBrowser(authUrl);

  let redirect;
  if (values["paste-code"]) {
    redirect = await prompt();
  } else {
    stdout(`patient-access: waiting for the redirect on ${redirectUri} ...`);
    redirect = await listen({ port });
  }
  assertStateMatches({
    redirect,
    state,
    pasteCode: Boolean(values["paste-code"]),
  });

  const token = await exchangeCodeForToken({
    tokenEndpoint: token_endpoint,
    code: redirect.code,
    clientId: values["client-id"],
    redirectUri,
    codeVerifier,
    fetchFn,
  });
  const patient = values.patient || token.patient;
  if (!patient) {
    throw new Error(
      `the token response carried no patient launch context — the ` +
        `ImagingStudy search has no one to search for; add --patient ` +
        `<id>, or request a patient-context scope (e.g. launch/patient)`
    );
  }
  return { token: token.access_token, patient };
}

export async function runPatientAccess({
  dcmjs: _dcmjs,
  positionals: _positionals,
  values,
  stdout,
  stderr,
  createAccess = DicomAccess.createInstance,
  fetchFn,
  listen = runLoopbackListener,
  prompt = promptForCode,
  openBrowser = defaultOpenBrowser,
}) {
  let flags;
  try {
    flags = validateFlags(values);
  } catch (err) {
    stderr(`patient-access: ${err.message}`);
    stderr(patientAccessUsage);
    return 2;
  }

  try {
    const fhirUrl = values["fhir-url"];

    // 1. Discovery — needed for the imaging endpoint (unless --imaging-url)
    //    and for the authorization endpoints (unless --token).
    let config;
    if (fhirUrl && (!values["imaging-url"] || !values.token)) {
      config = await fetchSmartConfiguration(fhirUrl, { fetchFn });
    }
    const imagingBase =
      values["imaging-url"] || findImagingEndpoint(config, fhirUrl);
    if (!imagingBase) {
      stderr(
        `patient-access: ${fhirUrl} advertises no smart-imaging-access ` +
          `endpoint (neither top-level capabilities nor ` +
          `associated_endpoints) — there is no imaging server to search; ` +
          `pass the imaging FHIR base explicitly with --imaging-url`
      );
      return 1;
    }

    // 2. Authorization — skipped entirely with --token.
    let token = values.token;
    let patient = values.patient;
    if (!token) {
      ({ token, patient } = await authorize({
        values,
        config,
        fhirUrl,
        port: flags.port,
        stdout,
        fetchFn,
        listen,
        prompt,
        openBrowser,
      }));
    }

    // 3. Find studies (+ their WADO-RS Endpoints) at the imaging endpoint.
    let { studies, url } = await searchImagingStudies({
      imagingBase,
      token,
      patient,
      lastUpdated: values["last-updated"],
      studyUid: values["study-uid"],
      fetchFn,
    });
    if (values["study-uid"]) {
      // Servers may ignore the identifier search parameter (the Argonaut
      // reference server does), so the narrowing is enforced here too.
      const want = values["study-uid"].replace(/^urn:oid:/, "");
      studies = studies.filter((s) => s.studyInstanceUID === want);
    }
    if (studies.length === 0) {
      stdout(
        `patient-access: 0 studies for patient ${patient} (${url}) — ` +
          `nothing to retrieve; check --patient, or loosen ` +
          `--last-updated/--study-uid`
      );
      return 0;
    }

    stdout(
      `patient-access: ${studies.length} ` +
        `${studies.length === 1 ? "study" : "studies"} for patient ` +
        `${patient} at ${imagingBase}`
    );
    for (const { study, studyInstanceUID, wadoBase } of studies) {
      const description = study.description || study.modality?.[0]?.code || "";
      stdout(
        `  ${studyInstanceUID}` +
          `${description ? `  [${description}]` : ""}  ` +
          `endpoint=${wadoBase}`
      );
    }
    if (values["dry-run"]) {
      stdout(
        `patient-access: dry run — stopping before retrieval ` +
          `(drop --dry-run to download)`
      );
      return 0;
    }

    // 4. Retrieve each study over WADO-RS with the same Bearer token.
    const destination = await createAccess(values.output, {
      scheme: "file",
      isDestination: true,
    });
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    for (const { studyInstanceUID, wadoBase } of studies) {
      const source = await createAccess(wadoBase, { headers });
      const srcStudy = await source.queryStudy(studyInstanceUID);
      await destination.store(srcStudy, { ...FORMATS[flags.format]() });
      stdout(
        `patient-access: study ${studyInstanceUID} → ` +
          `${values.output}/studies/${studyInstanceUID}`
      );

      if (values.fhir) {
        // The Patient here is rebuilt from instance tags — the FHIR
        // server's Patient resource is a reference in ImagingStudy.subject,
        // not part of the search Bundle.
        const layer = buildFhirLayer({
          naturals: collectStudyNaturals(srcStudy),
          wadoRoot: wadoBase,
        });
        for (const warning of layer.warnings) {
          stderr(`patient-access: warning: ${warning}`);
        }
        const fhirDir = writeFhirLayer(values.output, layer);
        stdout(
          `patient-access: fhir: Patient/${layer.patient.id}, ` +
            `ImagingStudy/${layer.imagingStudy.id} → ${fhirDir}`
        );
      }
    }
    stdout(
      `patient-access: ${studies.length} ` +
        `${studies.length === 1 ? "study" : "studies"} retrieved to ` +
        `${values.output} (${flags.format})`
    );
    return 0;
  } catch (err) {
    stderr(`patient-access: ${err.message}`);
    return 1;
  }
}
