#!/usr/bin/env node
// bin/dcmjs-mcp.js
//
// MCP stdio server exposing the dcmjs commands as tools for LLM toolchains.
// Same bundle-loading pattern as bin/dcmjs.js. Stdio discipline: the MCP
// transport owns stdout exclusively — loggers are silenced and diagnostics
// go to stderr.

import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "../src/mcp/server.js";

const require = createRequire(import.meta.url);

let dcmjs;
try {
  dcmjs = require("dcmjs");
} catch {
  console.error(
    "dcmjs-mcp needs the built dcmjs bundle.\n" +
      "If dcmjs is installed via file:../dcmjs, run `pnpm install && pnpm run build` in that checkout first."
  );
  process.exit(1);
}

dcmjs.log.setLevel("silent");
dcmjs.log.getLogger("validation.dcmjs").setLevel("silent");

const { version } = require("../package.json");

const server = createMcpServer({ dcmjs, version });
await server.connect(new StdioServerTransport());
console.error(`dcmjs-mcp ${version} listening on stdio`);
