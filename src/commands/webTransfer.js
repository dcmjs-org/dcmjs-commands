// src/commands/webTransfer.js
//
// The deduped implementation behind `dicomwebjs download` and
// `dicomwebjs part10` (formerly two near-identical bin/cli*.js files).
// DI core: no commander, no process — commander adapters live in
// bin/dicomwebjs.js and tests inject a fake createAccess.

import { DicomAccess } from "../access/DicomAccess.js";
import { setOptions } from "../utils/logger.js";
import {
  buildFhirLayer,
  writeFhirLayer,
  collectStudyNaturals,
  loadPatientResource,
  loadEncounterResource,
} from "../fhir/publishFhir.js";

const KINDS = {
  download: {
    preset: () => DicomAccess.DICOMWEB_OPTIONS,
    description: "Download a study into the Static DICOMweb file layout",
    done: (values, studyUID) =>
      `download complete: ${values.directory}/studies/${studyUID}`,
  },
  part10: {
    preset: () => DicomAccess.PART10_OPTIONS,
    description: "Convert DICOMweb data to Part 10 files",
    done: (values, studyUID) =>
      `part10 complete: ${values.directory}/studies/${studyUID}`,
  },
};

/**
 * Transfer a study from a DICOMweb (or static-file) source to the Static
 * DICOMweb file layout.
 * @param {Object} args
 * @param {Function} [args.createAccess] - DicomAccess factory (injectable)
 * @param {"download"|"part10"} args.kind
 * @returns {Promise<number>} exit code
 */
export async function runTransfer({
  createAccess = DicomAccess.createInstance,
  kind,
  positionals,
  values,
  stdout,
  stderr,
}) {
  const [url] = positionals;
  const spec = KINDS[kind];
  const studyUID = values.StudyInstanceUID;

  if (!url) {
    stderr(`${kind}: missing source URL`);
    return 2;
  }
  if (!studyUID) {
    stderr(`${kind}: please provide a StudyInstanceUID (-S <uid>)`);
    return 2;
  }

  try {
    const destination = await createAccess(values.directory, {
      ...values,
      scheme: "file",
      isDestination: true,
    });
    const access = await createAccess(url, values);
    const srcStudy = await access.queryStudy(studyUID);
    // Preset first, caller values override — and spread FLAT (the legacy
    // cliDownload nested the values under an `options` key by mistake).
    await destination.store(srcStudy, { ...spec.preset(), ...values });
    stdout(spec.done(values, studyUID));

    const wantFhir =
      kind === "download" &&
      (values.fhir ||
        values.fhirPatient ||
        values.fhirEncounter ||
        values.wadoRoot);
    if (wantFhir) {
      const layer = buildFhirLayer({
        naturals: collectStudyNaturals(srcStudy),
        patientResource: values.fhirPatient
          ? loadPatientResource(values.fhirPatient)
          : undefined,
        encounterResource: values.fhirEncounter
          ? loadEncounterResource(values.fhirEncounter)
          : undefined,
        wadoRoot: values.wadoRoot,
      });
      for (const warning of layer.warnings) {
        stderr(`${kind}: warning: ${warning}`);
      }
      const fhirDir = writeFhirLayer(values.directory, layer);
      stdout(
        `${kind}: fhir: Patient/${layer.patient.id}, ` +
          `ImagingStudy/${layer.imagingStudy.id} → ${fhirDir}`
      );
    }
    return 0;
  } catch (err) {
    stderr(`${kind}: ${err.message}`);
    return 1;
  }
}

/** Registers download/part10 on a commander program (bin adapter). */
export function registerTransferCommands(program) {
  for (const [kind, spec] of Object.entries(KINDS)) {
    program
      .command(kind)
      .description(spec.description)
      .argument("<url>", "DICOMweb URL or local Static DICOMweb path")
      .option(
        "-S, --StudyInstanceUID <StudyInstanceUID>",
        "StudyInstanceUID to transfer"
      )
      .option("-d, --directory <targetDir>", "target directory", ".")
      .option("--fhir", "also write a FHIR layer (download only)")
      .option("--fhir-patient <file>", "embed this FHIR Patient verbatim")
      .option("--fhir-encounter <file>", "embed this FHIR Encounter")
      .option("--wado-root <url>", "FHIR Endpoint.address for the tree")
      .option("--debug", "debug logging")
      .option("--verbose", "per-instance transfer narration")
      .option("--quiet", "errors only")
      .action(async (url, options) => {
        setOptions(options);
        process.exitCode = await runTransfer({
          kind,
          positionals: [url],
          values: options,
          stdout: (text) => process.stdout.write(text + "\n"),
          stderr: (text) => process.stderr.write(text + "\n"),
        });
      });
  }
}
