#!/usr/bin/env node

/**
 * OpenMemory MCP Server
 *
 * AI memory engine exposed as an MCP server.
 * Structured knowledge with server-side intelligence. Any AI tool can query it via MCP.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "openmemory",
  version: "0.0.1",
});

// Tools and resources will be registered here as they are implemented.
// See docs/design/mcp-tools.md for the full specification.

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
