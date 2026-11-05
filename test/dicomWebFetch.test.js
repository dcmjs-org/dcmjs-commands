// test/dicomWebFetch.test.js — API contract of the fetch DICOMweb client,
// against a local HTTP server.

import http from "node:http";
import {
  DicomWebFetch,
  DicomWebFetchError,
  FRAME_ACCEPT,
  PART10_ACCEPT,
} from "../src/access/DicomWebFetch.js";
import { requestHeaders } from "../src/commands/webTransfer.js";

let server;
let base;
let lastRequest;
// path -> (req, res) handler
const routes = new Map();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastRequest = req;
    const route = routes.get(req.url);
    if (route) return route(req, res);
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/dicomweb`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

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
