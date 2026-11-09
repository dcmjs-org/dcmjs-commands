// test/dimsejs.test.js — dimsejs echo/find/store/get against an in-process SCP

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dimse from "dcmjs-dimse";
import { runEcho, runFind, runStore, runGet } from "../src/commands/dimse.js";
import { readPart10Header } from "../src/dimse/Part10FileDataset.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "sample-dicom.dcm");

const { Server, Scp } = dimse;
const { CEchoResponse, CFindResponse, CStoreResponse, CGetResponse } =
  dimse.responses;
const { CStoreRequest } = dimse.requests;
const { Status, PresentationContextResult, TransferSyntax } = dimse.constants;

// What the SCP received: raw C-STORE bytes and decoded datasets
const received = { bytes: [], datasets: [] };
// The transfer syntaxes the SCP accepts, in order of preference
let acceptSyntaxes = [];
// The SOP classes the SCP rejects
let rejectSopClasses = [];

class TestScp extends Scp {
  associationRequested(association) {
    for (const { id } of association.getPresentationContexts()) {
      const context = association.getPresentationContext(id);
      const proposed = context.getTransferSyntaxUids();
      const syntax = acceptSyntaxes.find((s) => proposed.includes(s));
      if (rejectSopClasses.includes(context.getAbstractSyntaxUid())) {
        context.setResult(
          PresentationContextResult.RejectAbstractSyntaxNotSupported
        );
      } else if (syntax) {
        context.setResult(PresentationContextResult.Accept, syntax);
      } else {
        context.setResult(
          PresentationContextResult.RejectTransferSyntaxesNotSupported
        );
      }
    }
    this.sendAssociationAccept();
  }
  associationReleaseRequested() {
    this.sendAssociationReleaseResponse();
  }
  createDatasetFromStoreWritableStream(writable, context, callback) {
    received.bytes.push(writable.toBuffer());
    super.createDatasetFromStoreWritableStream(writable, context, callback);
  }
  cEchoRequest(request, callback) {
    const response = CEchoResponse.fromRequest(request);
    response.setStatus(Status.Success);
    callback(response);
  }
  cStoreRequest(request, callback) {
    received.datasets.push(request.getDataset());
    const response = CStoreResponse.fromRequest(request);
    response.setStatus(Status.Success);
    callback(response);
  }
  cFindRequest(request, callback) {
    // With nothing stored, the identifier itself is the one match
    const matches = received.datasets.length
      ? received.datasets
      : [request.getDataset()];
    const responses = matches.map((dataset) => {
      const response = CFindResponse.fromRequest(request);
      response.setStatus(Status.Pending);
      response.setDataset(dataset);
      return response;
    });
    const done = CFindResponse.fromRequest(request);
    done.setStatus(Status.Success);
    callback([...responses, done]);
  }
  cGetRequest(request, callback) {
    const store = new CStoreRequest(received.datasets[0]);
    store.on("response", () => {
      const response = CGetResponse.fromRequest(request);
      response.setStatus(Status.Success);
      response.setRemaining(0);
      response.setCompleted(1);
      response.setFailures(0);
      response.setWarnings(0);
      callback(response);
    });
    this.sendRequests(store);
  }
}

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

let server;
let port;
const values = { aet: "SCU", aec: "TEST", timeout: "10000" };

function capture() {
  const out = { stdout: [], stderr: [] };
  out.io = {
    stdout: (s) => out.stdout.push(s),
    stderr: (s) => out.stderr.push(s),
  };
  return out;
}

beforeAll(async () => {
  dimse.log.setLevel("silent");
  port = await freePort();
  server = new Server(TestScp);
  server.listen(port);
});

afterAll(() => server.close());

beforeEach(() => {
  received.bytes = [];
  received.datasets = [];
  rejectSopClasses = [];
  acceptSyntaxes = [
    TransferSyntax.ImplicitVRLittleEndian,
    TransferSyntax.ExplicitVRLittleEndian,
  ];
});

test("echo exits 0 when the SCP answers", async () => {
  const out = capture();
  const code = await runEcho({ host: "127.0.0.1", port, values, ...out.io });
  expect(code).toBe(0);
  expect(out.stdout.join()).toMatch(/success/);
});

test("echo exits 1 when no SCP listens", async () => {
  const out = capture();
  const code = await runEcho({
    host: "127.0.0.1",
    port: await freePort(),
    values,
    ...out.io,
  });
  expect(code).toBe(1);
  expect(out.stderr.join()).toMatch(/^echo: /);
});

test("store sends the file body unchanged when the SCP accepts its syntax", async () => {
  const out = capture();
  const code = await runStore({
    host: "127.0.0.1",
    port,
    inputs: [FIXTURE],
    values,
    ...out.io,
  });
  expect(code).toBe(0);
  const { bodyOffset } = readPart10Header(FIXTURE);
  const body = fs.readFileSync(FIXTURE).subarray(bodyOffset);
  expect(received.bytes).toHaveLength(1);
  expect(Buffer.compare(received.bytes[0], body)).toBe(0);
});

test("store transcodes when the SCP accepts only another syntax", async () => {
  acceptSyntaxes = [TransferSyntax.ExplicitVRLittleEndian];
  const out = capture();
  const code = await runStore({
    host: "127.0.0.1",
    port,
    inputs: [FIXTURE],
    values,
    ...out.io,
  });
  expect(code).toBe(0);
  expect(received.datasets[0].getTransferSyntaxUid()).toBe(
    TransferSyntax.ExplicitVRLittleEndian
  );
  expect(received.datasets[0].getElement("SOPInstanceUID")).toBe(
    readPart10Header(FIXTURE).sopInstanceUid
  );
});

test("store reports a file as not stored when the SCP rejects its SOP class", async () => {
  rejectSopClasses = [readPart10Header(FIXTURE).sopClassUid];
  const out = capture();
  const code = await runStore({
    host: "127.0.0.1",
    port,
    inputs: [FIXTURE],
    values,
    ...out.io,
  });
  expect(code).toBe(1);
  expect(out.stderr.join()).toContain(`${FIXTURE}: not sent`);
  expect(out.stdout.join()).toMatch(/0 of 1 instances stored/);
});

test("find gives an empty key with no Value", async () => {
  const out = capture();
  const code = await runFind({
    host: "127.0.0.1",
    port,
    values: { ...values, level: "study", key: ["AccessionNumber"] },
    ...out.io,
  });
  expect(code).toBe(0);
  const [match] = JSON.parse(out.stdout.join(""));
  expect(match["00080050"]).toEqual({ vr: "SH" });
});

test("find prints the matches as DICOM JSON", async () => {
  await runStore({
    host: "127.0.0.1",
    port,
    inputs: [FIXTURE],
    values,
    ...capture().io,
  });
  const out = capture();
  const code = await runFind({
    host: "127.0.0.1",
    port,
    values: { ...values, level: "study", key: [] },
    ...out.io,
  });
  expect(code).toBe(0);
  const [match] = JSON.parse(out.stdout.join(""));
  expect(match["00080018"]).toEqual({
    vr: "UI",
    Value: [readPart10Header(FIXTURE).sopInstanceUid],
  });
});

test("find rejects an unknown keyword before it connects", async () => {
  const out = capture();
  const code = await runFind({
    host: "127.0.0.1",
    port,
    values: { ...values, level: "study", key: ["NoSuchKeyword=1"] },
    ...out.io,
  });
  expect(code).toBe(2);
  expect(out.stderr.join()).toMatch(/unknown keyword "NoSuchKeyword"/);
});

test("get writes each retrieved instance as a Part 10 file", async () => {
  await runStore({
    host: "127.0.0.1",
    port,
    inputs: [FIXTURE],
    values,
    ...capture().io,
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dimsejs-get-"));
  const { sopInstanceUid } = readPart10Header(FIXTURE);
  const out = capture();
  const code = await runGet({
    host: "127.0.0.1",
    port,
    values: { ...values, study: "1.2.3", directory },
    ...out.io,
  });
  expect(code).toBe(0);
  const file = path.join(directory, `${sopInstanceUid}.dcm`);
  expect(readPart10Header(file).sopInstanceUid).toBe(sopInstanceUid);
  fs.rmSync(directory, { recursive: true });
});
