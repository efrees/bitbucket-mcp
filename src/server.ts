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
import { ClientCredentialsAuth } from "./auth/client-credentials-auth.js";
import { AuthSession } from "./auth/session.js";
import type { AuthProvider } from "./bitbucket/http-client.js";
import { BitbucketHttpClient } from "./bitbucket/http-client.js";
import { loadConfig } from "./config.js";
import type { AppConfig } from "./config.js";
import { log } from "./logger.js";
import { registerTools, ToolContext } from "./tools/index.js";

const SERVER_NAME = "bitbucket-mcp";
const SERVER_VERSION = "0.0.1";

export interface CreateServerResult {
  readonly server: McpServer;
  readonly context: ToolContext;
}

export interface CreateServerOptions {
  /** Allow write-side tools (posting comments, replies). Default: false. */
  readonly allowWrites?: boolean;
}

export function createServer(options: CreateServerOptions = {}): CreateServerResult {
  const config = loadConfig();
  const auth = createAuthProvider(config);
  const http = new BitbucketHttpClient(auth);

  const context: ToolContext = {
    config,
    auth,
    http,
    writesAllowed: options.allowWrites ?? false,
  };
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  registerTools(server, context);
  return { server, context };
}

/**
 * Build the right AuthProvider for the configured authMode. Exported so
 * CLI commands can build one without duplicating the switch.
 */
export function createAuthProvider(config: AppConfig): AuthProvider {
  if (config.authMode === "client_credentials") {
    return new ClientCredentialsAuth({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });
  }
  const tokenStore = createDefaultTokenStore();
  return new AuthSession({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    tokenStore,
  });
}

export async function startStdioServer(options: CreateServerOptions = {}): Promise<void> {
  const { server, context } = createServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("bitbucket-mcp: stdio server ready", { writesAllowed: context.writesAllowed });
}
