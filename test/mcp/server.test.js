// test/mcp/server.test.js
//
// The assembled MCP server over a linked in-memory transport pair: the
// tools list is discoverable with LLM-facing descriptions, a call routes
// end to end, and handler errors come back as isError results rather than
// protocol failures.

import path from "path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { TOOLS } from "../../src/mcp/registry.js";

const require = createRequire(import.meta.url);
const dcmjs = require("dcmjs");
dcmjs.log.setLevel("silent");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "..", "fixtures", "sample-dicom.dcm");

let client;

beforeEach(async () => {
  const server = createMcpServer({ dcmjs, version: "0.0.0-test" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
});

afterEach(async () => {
  await client.close();
});

test("tools/list exposes every registry tool with its description", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  expect(names).toEqual(Object.keys(TOOLS).sort());
  const convert = tools.find((t) => t.name === "dicom_convert");
  expect(convert.description).toMatch(/never reused/);
  expect(convert.inputSchema.properties.to).toBeDefined();
});

test("dicom_dump round-trips end to end", async () => {
  const result = await client.callTool({
    name: "dicom_dump",
    arguments: { file: FIXTURE },
  });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent.ok).toBe(true);
  expect(result.structuredContent.dataset.SOPInstanceUID).toBeDefined();
  // text content mirrors the structured result for clients that ignore it
  expect(JSON.parse(result.content[0].text).ok).toBe(true);
});

test("handler errors arrive as isError tool results", async () => {
  const result = await client.callTool({
    name: "dicom_convert",
    arguments: { input: FIXTURE, to: "dcm" },
  });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/pass output/);
});
