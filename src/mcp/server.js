// src/mcp/server.js
//
// Assemble an McpServer from the tool registry. Kept separate from the bin
// so tests can connect over InMemoryTransport with an injected dcmjs.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOLS } from "./registry.js";

/**
 * @param {{ dcmjs: Object, version?: string }} deps
 * @returns {McpServer}
 */
export function createMcpServer({ dcmjs, version = "0.1.0" }) {
  const server = new McpServer({ name: "dcmjs-mcp", version });

  for (const [name, spec] of Object.entries(TOOLS)) {
    server.registerTool(
      name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.inputSchema,
      },
      async (args) => {
        try {
          const result = await spec.handler({ dcmjs, args });
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (err) {
          // Corrective errors are the contract: state → consequence → the
          // parameter to change. The commands produce them; pass verbatim.
          return {
            isError: true,
            content: [{ type: "text", text: `${name}: ${err.message}` }],
          };
        }
      }
    );
  }

  return server;
}
