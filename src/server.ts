/**
 * MCP server factory and startup helper.
 *
 * `createServer` builds an `McpServer` and registers each tool from
 * `src/tools/`. `startStdioServer` wires it up to stdio and resolves
 * only when the transport closes (i.e. when the MCP client shuts the
 * server down by closing stdin), so the process stays alive serving
 * requests for the duration of the session.
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
  /** Allow write-side tools (posting comments and replies, opening PRs). Default: false. */
  readonly allowWrites?: boolean;
}

export async function createServer(options: CreateServerOptions = {}): Promise<CreateServerResult> {
  const config = await loadConfig();
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
  const scopeGate = registerTools(server, context);
  // Not awaited: in client_credentials mode this fetches a token, and a
  // slow or unreachable token endpoint must not hold up the MCP
  // handshake. A tool disabled after the client has listed tools is
  // announced via tools/list_changed. sync() never rejects.
  void scopeGate.sync(auth);
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
  const { server, context } = await createServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("bitbucket-mcp: stdio server ready", { writesAllowed: context.writesAllowed });

  // server.connect() resolves once the transport is *attached*, not when the
  // connection ends. If we returned here, main() would call process.exit(0)
  // before the client ever got to send its `initialize` request and the
  // server would die mid-handshake. Block until stdin closes (the MCP client
  // shutting us down) or the transport reports close/error.
  //
  // Note: the SDK's StdioServerTransport only fires its own `onclose` from
  // an explicit `transport.close()` call — it does NOT listen for stdin's
  // 'end' event itself. So we listen on stdin directly and treat that as
  // our signal to wind down.
  await new Promise<void>((resolve, reject) => {
    transport.onclose = () => resolve();
    transport.onerror = (err) => reject(err);
    process.stdin.once("end", () => resolve());
    process.stdin.once("close", () => resolve());
  });
  log.info("bitbucket-mcp: stdio transport closed; exiting");
}
