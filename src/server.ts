/**
 * MCP server factory.
 *
 * Phase 0: returns a server with no tools registered. Phases 2/3 will add
 * tool registrations here, delegating to the modules under `src/tools/`.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";

const SERVER_NAME = "bitbucket-mcp";
const SERVER_VERSION = "0.0.1";

export function createServer(): Server {
  return new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
}
