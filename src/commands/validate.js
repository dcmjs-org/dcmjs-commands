// src/commands/validate.mjs
//
// dcmjs validate <dir-or-file...> [--quiet] [--json <file>] [--conformance]
// Parse every discovered DICOM file through the classic read path and
// report per-file status. With --conformance, also run the dcmjs 2.0
// validation engine (structure, cross-field arithmetic, and — with
// --layers 1,2,3 — the Part 3 IOD rulebook). Exit 1 on any parse failure
// or conformance error. The heavier three-path divergence harness lives
// in scripts/corpus-runner.mjs.

import fs from "node:fs";
import path from "node:path";
import { readFileArrayBuffer, discoverDicomFiles } from "../io.js";

export const validateUsage = `usage: dcmjs validate <dir-or-file...> [options]

Parse DICOM files and report failures.

    --quiet          only print failures and the summary
    --json <file>    write the full report as JSON
    --conformance    also check conformance (dcmjs.validate, layers 1-2)
    --layers <list>  which conformance layers to run, e.g. --layers 1,2,3
                     (3 = the Part 3 IOD rulebook; implies --conformance)
    --ignore <rule>  suppress a conformance rule id (repeatable),
                     e.g. --ignore iod.conditional
`;

// Above this size the eager path cannot even read the file (Node's
// readFileSync caps at 2 GiB), so validation switches to the streaming
// parser — same conformance walk, bounded memory. Overridable for tests.
const STREAM_THRESHOLD_BYTES = 2 ** 31;

// The corrective text for every path that needs the conformance engine.
const CONFORMANCE_UNAVAILABLE_MESSAGE =
  "conformance checking requires the dcmjs validation engine, which " +
  "arrives with @dcmjs-org/validator; until then run without --conformance";

/**
 * Feature-detect the conformance engine. The 1.0-beta dcmjs ships without
 * dcmjs.validate (and its standalone validator package is a stub whose
 * validate() throws "not implemented"), so presence of a function is not
 * enough: probe it with an empty dataset inside try/catch. A real engine
 * returns a report (or at worst complains about the input); the stub
 * rejects with "not implemented".
 *
 * @param {Object} dcmjs the loaded dcmjs bundle
 * @returns {Promise<boolean>} whether dcmjs.validate is a working engine
 */
export async function conformanceAvailable(dcmjs) {
  if (typeof dcmjs.validate !== "function") {
    return false;
  }
  try {
    await dcmjs.validate({ dict: {}, meta: {} }, { layers: [1] });
    return true;
  } catch (err) {
    // "not implemented" is the stub; any other complaint means a real
    // engine objected to the probe input, which is fine.
    return !/not implemented/i.test(err?.message || String(err));
  }
}

// Fold a dcmjs.validate report into a file record. Errors make the file
// nonconformant (the dciodvfy convention: warnings and infos inform,
// errors fail); only non-info issues ride along, so a directory sweep's
// JSON stays readable.
function applyConformance(record, report) {
  record.conformance = report.summary;
  const notable = report.issues.filter((issue) => issue.severity !== "info");
  if (notable.length > 0) {
    record.issues = notable;
  }
  if (report.summary.errors > 0) {
    record.status = "nonconformant";
  }
}

// ValidationListener with the same completeness tracking the inert
// listener uses: endDataSet must have fired or the file was truncated.
function validatingCompletionListener(ValidationListener) {
  return class extends ValidationListener {
    _baseEndDataSet(...args) {
      super._baseEndDataSet(...args);
      this.done = true;
    }
  };
}

/**
 * The validation core, decoupled from output formatting: discover, parse,
 * record. Consumed by runValidate (line-oriented CLI output) and by the MCP
 * server (raw records as structured tool results).
 *
 * Files at or above `streamThreshold` bytes are parsed with the streaming
 * reader (an inert event-stream listener — success means the whole file
 * walked cleanly); such records carry `streamed: true`.
 *
 * `conformance`, when set, is a dcmjs.validate options object
 * ({ layers, ignore }); each successfully parsed file is then also
 * validated and its record gains a `conformance` summary. Files whose
 * report contains errors get status "nonconformant" and count as
 * failures. Streamed files validate through ValidationListener — same
 * rules, bounded memory.
 *
 * @param {{ dcmjs: Object, targets: string[], streamThreshold?: number,
 *           conformance?: { layers?: number[], ignore?: string[] } }} args
 * @returns {Promise<{ records: Array, failures: number }>}
 * @throws when a target cannot be walked or no DICOM files are found
 */
export async function validateFiles({
  dcmjs,
  targets,
  streamThreshold = STREAM_THRESHOLD_BYTES,
  conformance = null,
}) {
  const { DicomMessage } = dcmjs.data;
  const { fromPart10Stream, EventStreamListener } = dcmjs.eventStream;
  // v2-only: absent on 1.0-beta dcmjs, where base validation still works.
  const { ValidationListener } = dcmjs.validation ?? {};
  if (conformance && !(await conformanceAvailable(dcmjs))) {
    throw new Error(CONFORMANCE_UNAVAILABLE_MESSAGE);
  }
  const files = [];
  for (const target of targets) {
    discoverDicomFiles(target, files);
  }
  if (files.length === 0) {
    throw new Error("no DICOM files found");
  }

  // Chains bind in the constructor, so completeness tracking must be a
  // subclass, not a post-construction override.
  class CompletionListener extends EventStreamListener {
    _baseEndDataSet() {
      this.done = true;
    }
  }

  const records = [];
  let failures = 0;
  for (const file of files) {
    const relPath = path.relative(process.cwd(), file) || file;
    const startedAt = Date.now();
    try {
      const { size } = fs.statSync(file);
      if (size >= streamThreshold) {
        // The streaming reader resolves quietly on a truncated input, so
        // completeness is the check: endDataSet must have fired.
        if (conformance && !ValidationListener) {
          throw new Error(CONFORMANCE_UNAVAILABLE_MESSAGE);
        }
        const listener = conformance
          ? new (validatingCompletionListener(ValidationListener))(conformance)
          : new CompletionListener();
        await fromPart10Stream(
          fs.createReadStream(file, { highWaterMark: 8 * 1024 * 1024 }),
          listener
        );
        if (!listener.done) {
          throw new Error("input ended before the dataset completed");
        }
        const record = {
          file: relPath,
          status: "ok",
          bytes: size,
          streamed: true,
          ms: Date.now() - startedAt,
        };
        if (conformance) {
          applyConformance(record, listener.finish());
        }
        records.push(record);
      } else {
        const arrayBuffer = readFileArrayBuffer(file);
        const dicomDict = DicomMessage.readFile(arrayBuffer);
        const record = {
          file: relPath,
          status: "ok",
          bytes: arrayBuffer.byteLength,
          ms: Date.now() - startedAt,
        };
        if (conformance) {
          applyConformance(
            record,
            await dcmjs.validate(dicomDict, conformance)
          );
        }
        records.push(record);
      }
      if (records[records.length - 1].status === "nonconformant") {
        failures += 1;
      }
    } catch (err) {
      failures += 1;
      records.push({
        file: relPath,
        status: "fail",
        error: err.message || String(err),
        ms: Date.now() - startedAt,
      });
    }
  }
  return { records, failures };
}

export async function runValidate({
  dcmjs,
  positionals,
  values,
  stdout,
  stderr,
}) {
  if (positionals.length === 0) {
    stderr("validate: no input files or directories given");
    stderr(validateUsage);
    return 1;
  }

  let conformance = null;
  if (values.conformance || values.layers) {
    conformance = {};
    if (values.layers) {
      const layers = String(values.layers)
        .split(",")
        .map((n) => Number(n.trim()));
      if (layers.some((n) => ![1, 2, 3].includes(n))) {
        stderr(`validate: --layers must be a comma list drawn from 1,2,3`);
        return 1;
      }
      conformance.layers = layers;
    }
    if (values.ignore && values.ignore.length > 0) {
      conformance.ignore = values.ignore;
    }
  }

  let result;
  try {
    result = await validateFiles({ dcmjs, targets: positionals, conformance });
  } catch (err) {
    stderr(`validate: ${err.message}`);
    return 1;
  }
  const { records, failures } = result;

  let nonconformant = 0;
  for (const record of records) {
    if (record.status === "fail") {
      stdout(`FAIL  ${record.ms}ms  ${record.file}  (${record.error})`);
    } else if (record.status === "nonconformant") {
      nonconformant += 1;
      const { errors, warnings } = record.conformance;
      stdout(
        `NONCONFORMANT  ${record.file}  (${errors} error${
          errors === 1 ? "" : "s"
        }, ${warnings} warning${warnings === 1 ? "" : "s"})`
      );
      for (const issue of record.issues || []) {
        stdout(`    ${issue.severity}  ${issue.rule}  ${issue.message}`);
      }
    } else if (!values.quiet) {
      const summary = record.conformance
        ? `  (${record.conformance.warnings} warnings, ${record.conformance.infos} infos)`
        : "";
      stdout(
        `ok    ${record.bytes}B  ${record.ms}ms  ${record.file}${summary}`
      );
    }
  }

  const tail = conformance ? `, ${nonconformant} nonconformant` : "";
  stdout(
    `${records.length - failures}/${records.length} clean, ${
      failures - nonconformant
    } failed${tail}`
  );

  if (values.json) {
    fs.writeFileSync(values.json, JSON.stringify(records, null, 4));
  }

  return failures > 0 ? 1 : 0;
}
