// test/dicomWebFetch.test.js — API contract of the fetch DICOMweb client,
// against a local HTTP server.

import http from "node:http";
import {
  DicomWebFetch,
  DicomWebFetchError,
  FRAME_ACCEPT,
  PART10_ACCEPT,
} from "../src/access/DicomWebFetch.js";
import { DicomWebInstance } from "../src/access/DicomWebInstance.js";
import { requestHeaders } from "../src/commands/webTransfer.js";

let servers;
let base;
// A second port is a second origin, for the credential test.
let otherBase;
let lastRequest;
// path -> (req, res) handler
const routes = new Map();

beforeAll(async () => {
  const listen = async () => {
    const server = http.createServer((req, res) => {
      lastRequest = req;
      const route = routes.get(req.url);
      if (route) return route(req, res);
      res.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return server;
  };
  servers = [await listen(), await listen()];
  base = `http://127.0.0.1:${servers[0].address().port}/dicomweb`;
  otherBase = `http://127.0.0.1:${servers[1].address().port}`;
});
afterAll(() =>
  Promise.all(
    servers.map((server) => new Promise((resolve) => server.close(resolve)))
  )
);

/** A multipart response written in 5-byte chunks. */
const multipart = (message, boundary) => (req, res) => {
  res.writeHead(200, {
    "Content-Type": `multipart/related; boundary="${boundary}"`,
  });
  for (let i = 0; i < message.length; i += 5) {
    res.write(message.subarray(i, i + 5));
  }
  res.end();
};

const text = async (body) =>
  Buffer.from(await new Response(body).arrayBuffer());

test("API contract: a two-part response gives two parts with their own headers", async () => {
  const b = "XyZ";
  const message = Buffer.concat([
    Buffer.from(
      `preamble\r\n--${b}\r\nContent-Type: image/jls; transfer-syntax=1.2.840.10008.1.2.4.80\r\n\r\n`
    ),
    Buffer.from("first\r\n--Xy-not-a-boundary"),
    Buffer.from(
      `\r\n--${b}\r\nContent-Type: application/octet-stream; transfer-syntax=1.2.840.10008.1.2.1\r\n\r\n`
    ),
    Buffer.from([0, 1, 2, 13, 10, 45, 45]),
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  routes.set(
    "/dicomweb/studies/1/series/2/instances/3/frames/1,2",
    (req, res) => {
      res.writeHead(200, {
        "Content-Type": `multipart/related; type="image/jls"; boundary="${b}"`,
      });
      // Small chunks split the boundary across reads.
      for (let i = 0; i < message.length; i += 5) {
        res.write(message.subarray(i, i + 5));
      }
      res.end();
    }
  );

  const client = new DicomWebFetch({ url: base });
  const parts = [];
  for await (const { headers, body } of await client.retrieveFrames(
    "1",
    "2",
    "3",
    [1, 2]
  )) {
    parts.push({ type: headers.get("content-type"), data: await text(body) });
  }
  expect(lastRequest.headers.accept).toBe(FRAME_ACCEPT);
  expect(parts).toEqual([
    {
      type: "image/jls; transfer-syntax=1.2.840.10008.1.2.4.80",
      data: Buffer.from("first\r\n--Xy-not-a-boundary"),
    },
    {
      type: "application/octet-stream; transfer-syntax=1.2.840.10008.1.2.1",
      data: Buffer.from([0, 1, 2, 13, 10, 45, 45]),
    },
  ]);
});

test("API contract: headers (object or async function) and the Part 10 Accept", async () => {
  routes.set("/dicomweb/studies/1/series/2/instances/3", (req, res) => {
    res.writeHead(200, { "Content-Type": "application/dicom" }).end("DICM");
  });
  const client = new DicomWebFetch({
    url: `${base}/`,
    headers: async () =>
      requestHeaders(
        { header: ["X-Api-Key: abc"], token: "env:TEST_TOKEN" },
        { TEST_TOKEN: "t0k" }
      ),
  });
  const parts = await client.retrieveInstance("1", "2", "3");
  for await (const { body } of parts) {
    expect((await text(body)).toString()).toBe("DICM");
  }
  expect(lastRequest.headers.accept).toBe(PART10_ACCEPT);
  expect(lastRequest.headers["x-api-key"]).toBe("abc");
  expect(lastRequest.headers.authorization).toBe("Bearer t0k");

  expect(() => requestHeaders({ token: "env:UNSET_VAR" }, {})).toThrow(
    /not set/
  );
  expect(() =>
    requestHeaders({ header: ["authorization: Basic x"], token: "t" })
  ).toThrow(/not both/);
});

test("API contract: a body read after the next part is requested rejects, never returns the next part's bytes", async () => {
  const b = "B";
  routes.set(
    "/dicomweb/studies/1/series/2/instances/4/frames/1,2",
    multipart(
      Buffer.from(
        `--${b}\r\n\r\nFIRST-PART-BODY\r\n--${b}\r\n\r\nSECOND\r\n--${b}--\r\n`
      ),
      b
    )
  );
  const client = new DicomWebFetch({ url: base });
  const parts = await client.retrieveFrames("1", "2", "4", [1, 2]);
  const it = parts[Symbol.asyncIterator]();
  const first = (await it.next()).value;
  const second = (await it.next()).value;
  await expect(text(first.body)).rejects.toThrow(/next part/);
  expect((await text(second.body)).toString()).toBe("SECOND");
  await it.return();
});

test("User experience: an octet-stream frame without transfer-syntax is Explicit VR Little Endian, so part10 writes that syntax", async () => {
  const b = "C";
  routes.set(
    "/dicomweb/studies/1/series/2/instances/5/frames/1",
    multipart(
      Buffer.from(
        `--${b}\r\nContent-Type: application/octet-stream\r\n\r\nPIX\r\n--${b}--`
      ),
      b
    )
  );
  const instance = Object.assign(Object.create(DicomWebInstance.prototype), {
    dicomAccess: { client: new DicomWebFetch({ url: base }) },
    parent: { uid: "2", parent: { uid: "1" } },
    uid: "5",
  });
  const frame = await instance.openFrame(1);
  expect(frame.transferSyntaxUID).toBe("1.2.840.10008.1.2.1");
  expect(Buffer.from(frame.buffer).toString()).toBe("PIX");
});

test("API contract: credentials are not sent to a BulkDataURI on another origin", async () => {
  routes.set("/bulk", (req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream" }).end();
  });
  const client = new DicomWebFetch({
    url: base,
    headers: { Authorization: "Bearer secret" },
  });
  for await (const { body } of await client.retrieveBulkData(
    `${otherBase}/bulk`
  )) {
    await text(body);
  }
  expect(lastRequest.headers.authorization).toBeUndefined();
});

test("API contract: 404 and 429 reject with status, retryAfter and url", async () => {
  routes.set("/dicomweb/studies?StudyInstanceUID=9", (req, res) => {
    res.writeHead(429, { "Retry-After": "7" }).end("slow down");
  });
  const client = new DicomWebFetch({ url: base });

  const busy = await client
    .search("studies", { StudyInstanceUID: "9" })
    .catch((e) => e);
  expect(busy).toBeInstanceOf(DicomWebFetchError);
  expect(busy).toMatchObject({
    status: 429,
    retryAfter: "7",
    url: `${base}/studies?StudyInstanceUID=9`,
  });

  const missing = await client.retrieveMetadata("8").catch((e) => e);
  expect(missing).toMatchObject({
    status: 404,
    retryAfter: null,
    url: `${base}/studies/8/metadata`,
  });
});
