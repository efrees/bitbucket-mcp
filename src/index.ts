#!/usr/bin/env node
/**
 * bitbucket-mcp — stdio entry point.
 *
 * Phase 0: starts an empty MCP server over stdio so the build/run pipeline
 * is exercised end-to-end. Tools are registered in src/server.ts as we
 * implement Phases 2 and 3 (see ROADMAP.md).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Logging goes to stderr — stdout is reserved for MCP framing.
  process.stderr.write("bitbucket-mcp: ready (no tools registered yet)\n");
}

main().catch((err) => {
  process.stderr.write(`bitbucket-mcp: fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
