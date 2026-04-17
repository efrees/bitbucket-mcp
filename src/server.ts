/**
 * MCP server factory and startup helper.
 *
 * `createServer` builds an `McpServer` and registers each tool from
 * `src/tools/`. `startStdioServer` wires it up to stdio and returns
 * once the connection is established.
 *
 * Tool handlers receive the `ToolContext` so they can make Bitbucket
 * API calls against the authenticated session without reaching for
 * module-level globals.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDefaultTokenStore } from "./auth/index.js";
import { AuthSession } from "./auth/session.js";
import { BitbucketHttpClient } from "./bitbucket/http-client.js";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { registerTools, ToolContext } from "./tools/index.js";

const SERVER_NAME = "bitbucket-mcp";
const SERVER_VERSION = "0.0.1";

export interface CreateServerResult {
  readonly server: McpServer;
  readonly context: ToolContext;
}

export function createServer(): CreateServerResult {
  const config = loadConfig();
  const tokenStore = createDefaultTokenStore();
  const auth = new AuthSession({ clientId: config.clientId, tokenStore });
  const http = new BitbucketHttpClient(auth);

  const context: ToolContext = { config, auth, http };
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  registerTools(server, context);
  return { server, context };
}

export async function startStdioServer(): Promise<void> {
  const { server } = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("bitbucket-mcp: stdio server ready");
}
