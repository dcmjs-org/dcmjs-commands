// src/commands/dimse.js
//
// dimsejs echo | find | store | get: DIMSE SCU commands on dcmjs-dimse.
// DI core: no commander, no process. The commander adapter is
// registerDimseCommands, used by bin/dimsejs.js.

import fs from "node:fs";
import path from "node:path";
import dimse from "dcmjs-dimse";
import dcmjs from "../dcmjsBundle.js";
import { binaryReplacer, discoverDicomFiles } from "../io.js";
import { Part10FileDataset } from "../dimse/Part10FileDataset.js";

const { Client } = dimse;
const { Association } = dimse.association;
const { CEchoRequest, CFindRequest, CStoreRequest, CGetRequest } =
  dimse.requests;
const { CStoreResponse } = dimse.responses;
const { Status, TransferSyntax } = dimse.constants;

const DEFAULT_AET = "DCMJS";
const DEFAULT_AEC = "ANY-SCP";
const DEFAULT_TIMEOUT = 30000;

// C-FIND pending with "one or more Optional Keys were not supported" (PS3.4 C.4.1.1.4)
const PENDING_WARNING = 0xff01;
// C-STORE warnings: the SCP stored the instance (PS3.4 B.2.3)
const STORE_WARNINGS = [0xb000, 0xb006, 0xb007];

// A DICOM UID (PS3.5 9.1), also safe as a file name
const UID_PATTERN = /^(?=.{1,64}$)[0-9]+(\.[0-9]+)*$/;

const FIND_LEVELS = {
  study: "createStudyFindRequest",
  series: "createSeriesFindRequest",
  image: "createImageFindRequest",
  worklist: "createWorklistFindRequest",
};

/**
 * Sends the requests on one association, and resolves when the connection
 * closes.
 * @returns {Promise<void>}
 * @throws {Error} On a network error or an association rejection.
 */
function sendRequests(client, requests, { host, port, values }) {
  dimse.log.setLevel(
    values.debug ? "debug" : values.verbose ? "info" : "silent"
  );
  for (const request of requests) {
    client.addRequest(request);
  }
  return new Promise((resolve, reject) => {
    client.on("networkError", reject);
    client.on("associationRejected", (reject_) =>
      reject(
        new Error(
          `association rejected (result ${reject_.getResult()}, ` +
            `source ${reject_.getSource()}, reason ${reject_.getReason()})`
        )
      )
    );
    client.on("closed", resolve);
    client.send(host, Number(port), values.aet, values.aec, {
      connectTimeout: Number(values.timeout),
      associationTimeout: Number(values.timeout),
      pduTimeout: Number(values.timeout),
    });
  });
}

/** Describes a final DIMSE status for an error message. */
function statusText(status) {
  const name = Object.keys(Status).find((key) => Status[key] === status);
  return `0x${status.toString(16).padStart(4, "0")}${name ? ` (${name})` : ""}`;
}

/**
 * Converts a dcmjs-dimse Dataset to DICOM JSON. The dataset bytes go
 * through the dcmjs 1.0 event-stream reader and DicomWebJsonWriter, the
 * same writer as the Part 10 source of `dcmjs dicomweb`. Thus the JSON does not
 * depend on the naturalized shape of the dcmjs version inside dcmjs-dimse,
 * and an empty element has no Value (PS3.18 F.2.5).
 *
 * The bytes have no File Meta Information. The reader detects Implicit or
 * Explicit VR Little Endian from the first element, which covers the
 * transfer syntaxes that dcmjs-dimse proposes for C-FIND.
 * @returns {Promise<Object>} The DICOM JSON object.
 */
export async function datasetToDicomJson(dataset) {
  const { fromPart10Stream, DicomWebJsonWriter } = dcmjs.eventStream;
  const writer = new DicomWebJsonWriter();
  await fromPart10Stream(dataset.getDenaturalizedDataset(), writer, {
    allowMissingHeader: true,
  });
  return writer.result;
}

/** Parses repeated `-k Keyword=value` options into dataset elements. */
export function parseKeys(keys = []) {
  const elements = {};
  for (const key of keys) {
    const at = key.indexOf("=");
    const name = at < 0 ? key : key.slice(0, at);
    if (!dcmjs.data.DicomMetaDictionary.nameMap[name]) {
      throw new Error(`unknown keyword "${name}" in -k ${key}`);
    }
    elements[name] = at < 0 ? "" : key.slice(at + 1);
  }
  return elements;
}

/** dimsejs echo: verifies the association and the C-ECHO service. */
export async function runEcho({ host, port, values, stdout, stderr }) {
  const client = new Client();
  const request = new CEchoRequest();
  let status;
  request.on("response", (response) => (status = response.getStatus()));
  try {
    await sendRequests(client, [request], { host, port, values });
  } catch (err) {
    stderr(`echo: ${err.message}`);
    return 1;
  }
  if (status !== Status.Success) {
    stderr(
      `echo: no success response (status ${status === undefined ? "none" : statusText(status)})`
    );
    return 1;
  }
  stdout(`echo: success (${values.aec}@${host}:${port})`);
  return 0;
}

/** dimsejs find: prints the matches as a JSON array of DICOM JSON. */
export async function runFind({ host, port, values, stdout, stderr }) {
  const factory = FIND_LEVELS[values.level];
  if (!factory) {
    stderr(
      `find: unknown level "${values.level}"; use ${Object.keys(FIND_LEVELS).join(", ")}`
    );
    return 2;
  }
  let request;
  try {
    request = CFindRequest[factory](parseKeys(values.key));
  } catch (err) {
    stderr(`find: ${err.message}`);
    return 2;
  }
  const datasets = [];
  let status;
  let optionalKeysWarned = false;
  request.on("response", (response) => {
    status = response.getStatus();
    if (status === PENDING_WARNING && !optionalKeysWarned) {
      optionalKeysWarned = true;
      stderr("find: the SCP does not support one or more of the query keys");
    }
    const pending = status === Status.Pending || status === PENDING_WARNING;
    if (pending && response.hasDataset()) {
      datasets.push(response.getDataset());
    }
  });
  let matches;
  try {
    await sendRequests(new Client(), [request], { host, port, values });
    matches = await Promise.all(datasets.map(datasetToDicomJson));
  } catch (err) {
    stderr(`find: ${err.message}`);
    return 1;
  }
  const json = JSON.stringify(
    matches,
    binaryReplacer("base64"),
    values.pretty ? 2 : 0
  );
  if (values.output) {
    fs.writeFileSync(values.output, json);
  } else {
    stdout(json);
  }
  if (status !== Status.Success) {
    stderr(
      `find: final status ${status === undefined ? "none" : statusText(status)}`
    );
    return 1;
  }
  return 0;
}

/**
 * Sends Part 10 files to an SCP with C-STORE on one association. Each file
 * body goes unchanged when the SCP accepts the file's transfer syntax, and
 * dcmjs-dimse transcodes it otherwise. With `dryRun`, nothing connects: the
 * result lists the instances and the presentation contexts that dcmjs-dimse
 * would propose.
 * @param {Object} options
 * @param {string} options.host - SCP host.
 * @param {number|string} options.port - SCP port.
 * @param {string[]} options.inputs - Part 10 files or directories.
 * @param {string} [options.aet="DCMJS"] - Calling AE title.
 * @param {string} [options.aec="ANY-SCP"] - Called AE title.
 * @param {number} [options.timeout=30000] - Connection, association and PDU timeout in ms.
 * @param {boolean} [options.dryRun=false] - List the plan, send nothing.
 * @returns {Promise<{instances: Object[], stored: number, total: number,
 *   error?: string, presentationContexts?: Object[]}>} One record per file:
 *   `{file, sopClassUid, sopInstanceUid, transferSyntaxUid, result, status?,
 *   message?, warnings}` with result `stored`, `failed` or `planned`.
 *   `error` is a network error or an association rejection.
 * @throws {Error} When an input is missing or holds no DICOM file.
 */
export async function storeFiles({
  host,
  port,
  inputs,
  aet = DEFAULT_AET,
  aec = DEFAULT_AEC,
  timeout = DEFAULT_TIMEOUT,
  dryRun = false,
  verbose,
  debug,
}) {
  const files = inputs.flatMap((input) => discoverDicomFiles(input));
  if (!files.length) {
    throw new Error("no DICOM files found");
  }
  const instances = [];
  const sent = [];
  for (const file of files) {
    try {
      const dataset = new Part10FileDataset(file);
      const instance = {
        file,
        sopClassUid: dataset.sopClassUid,
        sopInstanceUid: dataset.sopInstanceUid,
        transferSyntaxUid: dataset.getTransferSyntaxUid(),
        warnings: [],
      };
      const entry = { instance, dataset, request: new CStoreRequest(dataset) };
      entry.request.on("response", (response) => {
        entry.status = response.getStatus();
      });
      instances.push(instance);
      sent.push(entry);
    } catch (err) {
      instances.push({
        file,
        result: "failed",
        message: err.message,
        warnings: [],
      });
    }
  }
  const report = (extra) => ({
    instances,
    stored: instances.filter((i) => i.result === "stored").length,
    total: files.length,
    ...extra,
  });

  if (dryRun) {
    // The same call and syntaxes as Client.send in dcmjs-dimse 0.3.4
    const association = new Association(aet, aec);
    for (const { instance, request } of sent) {
      association.addPresentationContextFromRequest(request, [
        TransferSyntax.ImplicitVRLittleEndian,
        TransferSyntax.ExplicitVRLittleEndian,
      ]);
      instance.result = "planned";
    }
    return report({
      presentationContexts: association
        .getPresentationContexts()
        .map(({ id, context }) => ({
          id,
          abstractSyntaxUid: context.getAbstractSyntaxUid(),
          transferSyntaxUids: context.getTransferSyntaxUids(),
        })),
    });
  }

  let error;
  try {
    if (sent.length) {
      await sendRequests(
        new Client(),
        sent.map((entry) => entry.request),
        { host, port, values: { aet, aec, timeout, verbose, debug } }
      );
    }
  } catch (err) {
    error = err.message;
  }
  const { unencapsulatedTransferSyntaxes } = dcmjs.constants;
  for (const { instance, dataset, status } of sent) {
    instance.result = "failed";
    // dcmjs-dimse sends no request for a rejected presentation context
    if (status === undefined) {
      instance.message = "not sent (no response from the SCP)";
    } else {
      instance.status = statusText(status);
      if (status === Status.Success || STORE_WARNINGS.includes(status)) {
        instance.result = "stored";
      } else {
        instance.message = `status ${instance.status}`;
      }
      if (STORE_WARNINGS.includes(status)) {
        instance.warnings.push(`stored with warning ${instance.status}`);
      }
    }
    if (
      dataset.decoded &&
      !unencapsulatedTransferSyntaxes[instance.transferSyntaxUid]
    ) {
      instance.warnings.push(
        `decompressed from ${instance.transferSyntaxUid}; ` +
          "dcmjs-dimse removes the private elements in this conversion"
      );
    }
  }
  return report(error ? { error } : {});
}

/** dimsejs store: sends Part 10 files, with the file bytes unchanged. */
export async function runStore({ host, port, inputs, values, stdout, stderr }) {
  let result;
  try {
    result = await storeFiles({
      host,
      port,
      inputs,
      aet: values.aet,
      aec: values.aec,
      timeout: Number(values.timeout),
      dryRun: values.dryRun,
      verbose: values.verbose,
      debug: values.debug,
    });
  } catch (err) {
    stderr(`store: ${err.message}`);
    return 2;
  }
  if (values.dryRun) {
    stdout(JSON.stringify(result, null, 2));
    return result.instances.some((i) => i.result === "failed") ? 1 : 0;
  }
  if (result.error) {
    stderr(`store: ${result.error}`);
  }
  for (const { file, warnings } of result.instances) {
    for (const warning of warnings) {
      stderr(`store: ${file}: ${warning}`);
    }
  }
  for (const { file, result: outcome, message } of result.instances) {
    if (outcome === "failed") {
      stderr(`store: ${file}: ${message}`);
    }
  }
  stdout(`store: ${result.stored} of ${result.total} instances stored`);
  return result.stored < result.total || result.error ? 1 : 0;
}

/** dimsejs get: retrieves instances with C-GET into Part 10 files. */
export async function runGet({ host, port, values, stdout, stderr }) {
  const { study, series, instance, directory } = values;
  if (!study || (instance && !series)) {
    stderr(
      "get: give -S <StudyInstanceUID>, with --series and --instance for a smaller level"
    );
    return 2;
  }
  const request = instance
    ? CGetRequest.createImageGetRequest(study, series, instance)
    : series
      ? CGetRequest.createSeriesGetRequest(study, series)
      : CGetRequest.createStudyGetRequest(study);
  let status;
  let failed = 0;
  request.on("response", (response) => {
    status = response.getStatus();
    failed = response.getFailures() || failed;
  });

  fs.mkdirSync(directory, { recursive: true });
  const written = [];
  const client = new Client();
  client.on("cStoreRequest", (storeRequest, callback) => {
    const response = CStoreResponse.fromRequest(storeRequest);
    try {
      const dataset = storeRequest.getDataset();
      // The UID comes from the network; use it as a file name only when valid
      const uid = storeRequest.getAffectedSopInstanceUid();
      const name = UID_PATTERN.test(uid)
        ? uid
        : `instance-${written.length + 1}`;
      const file = path.join(directory, `${name}.dcm`);
      // shortcut: dcmjs-dimse 0.3.4 decodes each received instance, so it is
      // written again from its elements; use a raw store stream when the client offers one
      dataset.toFile(file);
      written.push(file);
      response.setStatus(Status.Success);
    } catch (err) {
      stderr(`get: ${err.message}`);
      response.setStatus(Status.ProcessingFailure);
    }
    callback(response);
  });
  try {
    await sendRequests(client, [request], { host, port, values });
  } catch (err) {
    stderr(`get: ${err.message}`);
    return 1;
  }
  stdout(`get: ${written.length} instances written to ${directory}`);
  if (!written.length) {
    stderr("get: the SCP sent no instances; check the UIDs");
  }
  if (status !== Status.Success || failed) {
    stderr(
      `get: final status ${status === undefined ? "none" : statusText(status)}, ${failed} failed`
    );
    return 1;
  }
  return 0;
}

/** Adds the options that every DIMSE command uses. */
function connectionOptions(command) {
  return command
    .argument("<host>", "SCP host name or address")
    .argument("<port>", "SCP port")
    .option("--aet <title>", "calling AE title (this SCU)", DEFAULT_AET)
    .option("--aec <title>", "called AE title (the SCP)", DEFAULT_AEC)
    .option(
      "--timeout <ms>",
      "connection, association and PDU timeout",
      String(DEFAULT_TIMEOUT)
    )
    .option("--verbose", "log the DIMSE messages")
    .option("--debug", "debug logging");
}

/** Gives the usage error for a bad port or timeout, or undefined. */
export function usageError(port, timeout) {
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    return `port "${port}" must be an integer from 1 to 65535`;
  }
  if (!(Number(timeout) > 0)) {
    return `--timeout "${timeout}" must be a positive number of milliseconds`;
  }
  return undefined;
}

/** Registers echo/find/store/get on a commander program (bin adapter). */
export function registerDimseCommands(program, { stdout, stderr, exit }) {
  const run =
    (fn) =>
    async (...args) => {
      const command = args[args.length - 1];
      const [host, port, ...rest] = command.args;
      const values = command.opts();
      const usage = usageError(port, values.timeout);
      if (usage) {
        stderr(`${command.name()}: ${usage}`);
        return exit(2);
      }
      exit(
        await fn({
          host,
          port,
          inputs: rest,
          values,
          stdout,
          stderr,
        })
      );
    };

  connectionOptions(
    program.command("echo").description("Send a C-ECHO to an SCP")
  ).action(run(runEcho));

  connectionOptions(
    program
      .command("find")
      .description("Query an SCP with C-FIND; prints DICOM JSON")
  )
    .option("-L, --level <level>", "study, series, image or worklist", "study")
    .option(
      "-k, --key <Keyword=value>",
      "query key; repeat for each key",
      (v, all) => [...all, v],
      []
    )
    .option("-o, --output <file>", "write the JSON to a file")
    .option("-p, --pretty", "pretty print")
    .action(run(runFind));

  connectionOptions(
    program
      .command("store")
      .description("Send Part 10 files to an SCP with C-STORE")
  )
    .argument("<file-or-directory...>", "Part 10 files or directories")
    .option(
      "--dry-run",
      "print the instances and the proposed presentation contexts as JSON; send nothing"
    )
    .action(run(runStore));

  connectionOptions(
    program
      .command("get")
      .description("Retrieve instances with C-GET into Part 10 files")
  )
    .option("-S, --study <uid>", "StudyInstanceUID")
    .option("--series <uid>", "SeriesInstanceUID")
    .option("--instance <uid>", "SOPInstanceUID")
    .option("-d, --directory <dir>", "output directory", ".")
    .action(run(runGet));
}
