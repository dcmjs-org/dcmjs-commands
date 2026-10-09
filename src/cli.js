// src/cli.js
//
// Command router for the dcmjs bin. Parsing is node:util parseArgs;
// commands receive an injected `dcmjs` (the built bundle from bin/, or a
// test-supplied instance) plus stdout/stderr sinks, and return exit codes.
// The dicomwebjs bin keeps commander for its legacy surface — this router
// only serves the local-file `dcmjs` commands.

import { parseArgs } from "node:util";
import { runConvert, convertUsage } from "./commands/convert.js";
import { runDump, dumpUsage } from "./commands/dump.js";
import { runInstance, instanceUsage } from "./commands/instance.js";
import { runAnonymize, anonymizeUsage } from "./commands/anonymize.js";
import { runValidate, validateUsage } from "./commands/validate.js";
import { runFilter, filterUsage } from "./commands/filter.js";
import { runDicomdir, dicomdirUsage } from "./commands/dicomdir.js";
import { runDicomweb, dicomwebUsage } from "./commands/dicomweb.js";
import {
  runPatientAccess,
  patientAccessUsage,
} from "./commands/patientAccess.js";
import { runTranscode, transcodeUsage } from "./commands/transcode.js";
import { runWsiResize, wsiResizeUsage } from "./commands/wsiresize.js";

export const usage = `usage: dcmjs <command> [options]

Commands:
    convert     convert between DICOM, PDF, PNG/JPEG, MP4 video, FHIR, and JSON
    dump        print a DICOM file's dataset (tag lines; --json for JSON)
    instance    print a DICOM file's dict as tag-keyed DICOM JSON
    anonymize   strip PHI tags and write a scrubbed copy
    filter      stream a file through an event-stream filter chain
    validate    parse files/directories and report failures
    dicomdir    build a DICOMDIR indexing a directory of DICOM files
    dicomweb    publish a directory of DICOM files as a Static-DICOMweb tree
    transcode   rewrite pixel data in another transfer syntax, frame by frame
    wsiresize   rebuild a whole-slide image pyramid (tile size, levels, codec)
    patient-access
                fetch a patient's imaging studies via SMART Imaging Access
                (FHIR discovery → App Launch → WADO-RS retrieval)

Run 'dcmjs <command> --help' for command options.
`;

const COMMANDS = {
  convert: {
    run: runConvert,
    usage: convertUsage,
    options: {
      to: { type: "string", short: "t" },
      output: { type: "string", short: "o" },
      pretty: { type: "boolean", default: false },
      bundle: { type: "boolean", default: false },
      "fhir-version": { type: "string" },
      "patient-name": { type: "string" },
      "patient-id": { type: "string" },
      title: { type: "string" },
      "study-uid": { type: "string" },
      "series-uid": { type: "string" },
      metadata: { type: "string", short: "m" },
      "restore-values": { type: "boolean", default: false },
      "fhir-patient": { type: "string" },
      "fragment-bytes": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  },
  dump: {
    run: runDump,
    usage: dumpUsage,
    options: {
      json: { type: "boolean", default: false },
      raw: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  },
  instance: {
    run: runInstance,
    usage: instanceUsage,
    options: {
      pretty: { type: "boolean", short: "p", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  },
  anonymize: {
    run: runAnonymize,
    usage: anonymizeUsage,
    options: {
      output: { type: "string", short: "o" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  },
  filter: {
    run: runFilter,
    usage: filterUsage,
    options: {
      output: { type: "string", short: "o" },
      set: { type: "string", multiple: true },
      drop: { type: "string", multiple: true },
      module: { type: "string", multiple: true },
      "fhir-patient": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  },
  validate: {
    run: runValidate,
    usage: validateUsage,
    options: {
      quiet: { type: "boolean", default: false },
      json: { type: "string" },
      conformance: { type: "boolean", default: false },
      layers: { type: "string" },
      ignore: { type: "string", multiple: true },
      help: { type: "boolean", short: "h", default: false },
    },
  },
  dicomdir: {
    run: runDicomdir,
    usage: dicomdirUsage,
    options: {
      output: { type: "string", short: "o" },
      copy: { type: "string" },
      "fileset-id": { type: "string" },
      strict: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  },
  dicomweb: {
    run: runDicomweb,
    usage: dicomwebUsage,
    options: {
      directory: { type: "string", short: "d" },
      study: { type: "string", short: "S" },
      fhir: { type: "boolean", default: false },
      "fhir-patient": { type: "string" },
      "fhir-encounter": { type: "string" },
      "wado-root": { type: "string" },
      verbose: { type: "boolean", default: false },
      debug: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  },
  transcode: {
    run: runTranscode,
    usage: transcodeUsage,
    options: {
      to: { type: "string", short: "t" },
      directory: { type: "string", short: "d" },
      lossy: { type: "boolean", default: false },
      lossless: { type: "boolean", default: false },
      quality: { type: "string" },
      distance: { type: "string" },
      effort: { type: "string" },
      progressive: { type: "boolean", default: false },
      "new-series": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      quiet: { type: "boolean", short: "q", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  },
  wsiresize: {
    run: runWsiResize,
    usage: wsiResizeUsage,
    options: {
      directory: { type: "string", short: "d" },
      "in-place": { type: "boolean", default: false },
      preset: { type: "string", short: "p" },
      to: { type: "string", short: "t" },
      tile: { type: "string" },
      factor: { type: "string" },
      quality: { type: "string" },
      distance: { type: "string" },
      effort: { type: "string" },
      "no-progressive": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      quiet: { type: "boolean", short: "q", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  },
  "patient-access": {
    run: runPatientAccess,
    usage: patientAccessUsage,
    options: {
      "fhir-url": { type: "string" },
      "imaging-url": { type: "string" },
      patient: { type: "string" },
      token: { type: "string" },
      "client-id": { type: "string" },
      "redirect-port": { type: "string" },
      "paste-code": { type: "boolean", default: false },
      scope: { type: "string" },
      "last-updated": { type: "string" },
      "study-uid": { type: "string" },
      output: { type: "string", short: "o" },
      format: { type: "string" },
      fhir: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  },
};

export async function runCli({ dcmjs, argv, stdout, stderr }) {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    if (command) {
      stdout(usage);
      return 0;
    }
    stderr(usage);
    return 1;
  }

  const spec = COMMANDS[command];
  if (!spec) {
    stderr(`dcmjs: unknown command "${command}"`);
    stderr(usage);
    return 1;
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: spec.options,
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    stderr(`dcmjs ${command}: ${err.message}`);
    stderr(spec.usage);
    return 1;
  }

  if (parsed.values.help) {
    stdout(spec.usage);
    return 0;
  }

  return spec.run({
    dcmjs,
    positionals: parsed.positionals,
    values: parsed.values,
    stdout,
    stderr,
  });
}
