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
const { CEchoRequest, CFindRequest, CStoreRequest, CGetRequest } =
  dimse.requests;
const { CStoreResponse } = dimse.responses;
const { Status } = dimse.constants;

// A DICOM UID (PS3.5 9.1), also safe as a file name
const UID_PATTERN = /^[0-9.]{1,64}$/;

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
 * same pair as `dcmjs dump` and `dcmjs dicomweb`. Thus the JSON does not
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
  request.on("response", (response) => {
    status = response.getStatus();
    if (status === Status.Pending && response.hasDataset()) {
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

/** dimsejs store: sends Part 10 files, with the file bytes unchanged. */
export async function runStore({ host, port, inputs, values, stdout, stderr }) {
  let files;
  try {
    files = inputs.flatMap((input) => discoverDicomFiles(input));
  } catch (err) {
    stderr(`store: ${err.message}`);
    return 2;
  }
  if (!files.length) {
    stderr("store: no DICOM files found");
    return 2;
  }
  const failures = [];
  const sent = [];
  for (const file of files) {
    try {
      const dataset = new Part10FileDataset(file);
      const entry = { file, dataset, request: new CStoreRequest(dataset) };
      entry.request.on("response", (response) => {
        entry.status = response.getStatus();
      });
      sent.push(entry);
    } catch (err) {
      failures.push(`${file}: ${err.message}`);
    }
  }
  let code = 0;
  try {
    if (sent.length) {
      await sendRequests(
        new Client(),
        sent.map((entry) => entry.request),
        { host, port, values }
      );
    }
  } catch (err) {
    stderr(`store: ${err.message}`);
    code = 1;
  }
  const { unencapsulatedTransferSyntaxes } = dcmjs.constants;
  for (const { file, dataset, status } of sent) {
    // dcmjs-dimse sends no request for a rejected presentation context
    if (status === undefined) {
      failures.push(`${file}: not sent (no response from the SCP)`);
    } else if (status !== Status.Success) {
      failures.push(`${file}: status ${statusText(status)}`);
    }
    const syntax = dataset.getTransferSyntaxUid();
    if (dataset.decoded && !unencapsulatedTransferSyntaxes[syntax]) {
      stderr(
        `store: ${file}: decompressed from ${syntax}; ` +
          "dcmjs-dimse removes the private elements in this conversion"
      );
    }
  }
  for (const failure of failures) {
    stderr(`store: ${failure}`);
  }
  stdout(
    `store: ${files.length - failures.length} of ${files.length} instances stored`
  );
  return failures.length ? 1 : code;
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
    .option("--aet <title>", "calling AE title (this SCU)", "DCMJS")
    .option("--aec <title>", "called AE title (the SCP)", "ANY-SCP")
    .option(
      "--timeout <ms>",
      "connection, association and PDU timeout",
      "30000"
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
