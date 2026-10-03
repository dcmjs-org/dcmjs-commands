// src/commands/dicomweb.js
//
// dcmjs dicomweb <directory> [options]
//
// Publish a directory of Part 10 DICOM files as a Static-DICOMweb tree —
// the sibling of `dcmjs dicomdir`: same input (a folder of DICOM files),
// different index (the modern web layout instead of the CD one). Built on
// the Part10DirectoryAccess source and the same destination machinery
// `dicomwebjs download` uses.

import { DicomAccess } from "../access/DicomAccess.js";
import { setOptions } from "../utils/logger.js";
import {
  buildFhirLayer,
  writeFhirLayer,
  collectStudyNaturals,
  loadPatientResource,
  loadEncounterResource,
} from "../fhir/publishFhir.js";

export const dicomwebUsage = `usage: dcmjs dicomweb <directory> [options]

Build a Static-DICOMweb tree (studies/<uid>/...) from a directory of
Part 10 DICOM files. With --fhir, also write a FHIR layer under
<dest>/fhir — Patient, ImagingStudy, and a DICOMweb Endpoint, plus a
transaction Bundle.json a FHIR server can load in one POST.

    -d, --directory <dest>   output root (default: ./dicomweb)
    -S, --study <uid>        publish only this StudyInstanceUID
                             (default: every study found)
    --fhir                   also write the FHIR layer (dicomweb+fhir format)
    --fhir-patient <file>    embed this FHIR Patient verbatim as the
                             authoritative Patient (mismatch vs instance
                             tags is warned about, not fixed — use
                             'dcmjs filter --fhir-patient' for that)
    --fhir-encounter <file>  embed this FHIR Encounter and reference it from
                             ImagingStudy.encounter (not mapped onto tags)
    --wado-root <url>        Endpoint.address for the FHIR Endpoint
                             (default http://localhost:5000/dicomweb —
                             set this to wherever the tree will be served)
    --verbose                per-instance transfer narration
    --debug                  debug logging
    --quiet                  errors only
`;

export async function runDicomweb({
  dcmjs: _dcmjs,
  positionals,
  values,
  stdout,
  stderr,
  createAccess = DicomAccess.createInstance,
}) {
  const [sourceDir] = positionals;
  if (!sourceDir) {
    stderr("dicomweb: missing <directory>");
    stderr(dicomwebUsage);
    return 1;
  }
  setOptions(values);
  const destDir = values.directory || "./dicomweb";

  try {
    const source = await createAccess(sourceDir, {});
    const destination = await createAccess(destDir, {
      scheme: "file",
      isDestination: true,
    });

    const patientResource = values["fhir-patient"]
      ? loadPatientResource(values["fhir-patient"])
      : undefined;
    const encounterResource = values["fhir-encounter"]
      ? loadEncounterResource(values["fhir-encounter"])
      : undefined;
    const wantFhir =
      values.fhir ||
      patientResource ||
      encounterResource ||
      values["wado-root"];

    let studyUIDs;
    if (typeof source.scan === "function") {
      const { groups, skipped } = await source.scan();
      // A file the scan could not use is missing DATA, not a diagnostic —
      // always on stderr, whatever the log level.
      for (const skip of skipped) {
        stderr(`dicomweb: warning: skipped ${skip.file} (${skip.error})`);
      }
      studyUIDs = values.study ? [values.study] : [...groups.keys()];
    } else if (values.study) {
      studyUIDs = [values.study];
    } else {
      throw new Error(
        `${sourceDir} is not a directory of Part 10 files — pass ` +
          `-S <StudyInstanceUID> to publish from a DICOMweb source`
      );
    }

    for (const studyUID of studyUIDs) {
      const srcStudy = await source.queryStudy(studyUID);
      await destination.store(srcStudy, {
        ...DicomAccess.DICOMWEB_OPTIONS,
      });
      stdout(`dicomweb: study ${studyUID} → ${destDir}/studies/${studyUID}`);

      if (wantFhir) {
        const layer = buildFhirLayer({
          naturals: collectStudyNaturals(srcStudy),
          patientResource,
          encounterResource,
          wadoRoot: values["wado-root"],
        });
        for (const warning of layer.warnings) {
          stderr(`dicomweb: warning: ${warning}`);
        }
        const fhirDir = writeFhirLayer(destDir, layer);
        stdout(
          `dicomweb: fhir: Patient/${layer.patient.id}, ` +
            `ImagingStudy/${layer.imagingStudy.id}` +
            `${layer.encounter ? `, Encounter/${layer.encounter.id}` : ""} ` +
            `→ ${fhirDir} (Bundle.json is FHIR-server loadable)`
        );
      }
    }
    stdout(
      `dicomweb: ${studyUIDs.length} ` +
        `${studyUIDs.length === 1 ? "study" : "studies"} published to ${destDir}`
    );
    return 0;
  } catch (err) {
    stderr(`dicomweb: ${err.message}`);
    return 1;
  }
}
