/**
 * CLI subcommand handlers.
 *
 * The default invocation (no subcommand) starts the MCP stdio server.
 * The named subcommands are user-facing setup/diagnostic tools:
 *
 *   bitbucket-mcp login    — run OAuth 3LO and persist tokens (auth_code mode only)
 *   bitbucket-mcp logout   — wipe stored tokens (auth_code mode only)
 *   bitbucket-mcp whoami   — describe the current auth state
 *
 * These commands write human-readable output to stdout (safe: they never
 * speak MCP protocol). Errors go to stderr and exit non-zero so shell
 * scripts can gate on them.
 */

import { ClientCredentialsAuth } from "../auth/client-credentials-auth.js";
import { createDefaultTokenStore } from "../auth/index.js";
import { DEFAULT_CALLBACK_PORT, performLogin } from "../auth/login-flow.js";
import { AuthSession } from "../auth/session.js";
import { loadConfig } from "../config.js";
import type { AppConfig } from "../config.js";
import { AuthError, ConfigError } from "../errors.js";

export async function runLogin(): Promise<number> {
  const config = loadConfig();
  if (config.authMode !== "authorization_code") {
    process.stderr.write(
      `login is only used in authMode=authorization_code. ` +
        `You're configured for authMode=${config.authMode}, which doesn't need a login step — ` +
        `just set BITBUCKET_MCP_CLIENT_ID and BITBUCKET_MCP_CLIENT_SECRET and run the server.\n`,
    );
    return 2;
  }

  const tokenStore = createDefaultTokenStore();
  const session = new AuthSession({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    tokenStore,
  });

  const callbackPort = parseCallbackPort(process.env["BITBUCKET_MCP_CALLBACK_PORT"]);
  process.stdout.write(
    "Starting Bitbucket login. Your browser will open for consent.\n" +
      `(Callback will hit http://127.0.0.1:${callbackPort}/callback — ` +
      "this must match the callback URL on your OAuth consumer.)\n\n",
  );
  const token = await performLogin({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    callbackPort,
  });
  await session.setToken(token);
  process.stdout.write(
    `\nSuccess — logged in as ${token.user.displayName} (${token.user.uuid}).\n` +
      `Tokens saved to the OS-encrypted store.\n`,
  );
  return 0;
}

export async function runLogout(): Promise<number> {
  const config = loadConfig();
  if (config.authMode !== "authorization_code") {
    process.stdout.write(
      `Nothing to do — authMode=${config.authMode} doesn't persist tokens to disk.\n`,
    );
    return 0;
  }

  const tokenStore = createDefaultTokenStore();
  await tokenStore.clear();
  process.stdout.write("Logged out. Stored tokens removed.\n");
  return 0;
}

export async function runWhoami(): Promise<number> {
  const config = loadConfig();
  try {
    if (config.authMode === "client_credentials") {
      return await whoamiClientCredentials(config);
    }
    return await whoamiAuthorizationCode(config);
  } catch (err) {
    if (err instanceof AuthError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    throw err;
  }
}

async function whoamiAuthorizationCode(config: AppConfig): Promise<number> {
  const tokenStore = createDefaultTokenStore();
  const session = new AuthSession({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    tokenStore,
  });
  const user = await session.whoami();
  process.stdout.write(
    `authMode=authorization_code — logged in as ${user.displayName} (${user.uuid})` +
      (user.accountId ? ` account_id=${user.accountId}` : "") +
      "\n",
  );
  return 0;
}

async function whoamiClientCredentials(config: AppConfig): Promise<number> {
  // Actively fetch a token so the user sees whether their credentials are valid.
  const auth = new ClientCredentialsAuth({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });
  await auth.getAccessToken();
  const workspace = config.defaultWorkspace ?? "(none configured)";
  process.stdout.write(
    `authMode=client_credentials — consumer ${config.clientId}, workspace: ${workspace}. ` +
      `Token fetch succeeded.\n`,
  );
  return 0;
}

export async function runHelp(): Promise<number> {
  process.stdout.write(
    [
      "bitbucket-mcp — Bitbucket Cloud MCP server",
      "",
      "Usage:",
      "  bitbucket-mcp                     start the MCP stdio server (default)",
      "  bitbucket-mcp --allow-writes      start the server with write tools enabled",
      "  bitbucket-mcp login               interactive OAuth login (authorization_code mode)",
      "  bitbucket-mcp logout              remove stored tokens (authorization_code mode)",
      "  bitbucket-mcp whoami              print the current auth state",
      "  bitbucket-mcp help                show this message",
      "",
      "Config:",
      "  BITBUCKET_MCP_AUTH_MODE       client_credentials (default) | authorization_code",
      "  BITBUCKET_MCP_CLIENT_ID       OAuth consumer key (required)",
      "  BITBUCKET_MCP_CLIENT_SECRET   OAuth consumer secret (required)",
      "  BITBUCKET_MCP_WORKSPACE       default workspace slug (optional)",
      "  BITBUCKET_MCP_CALLBACK_PORT   loopback port for OAuth callback (default: 33378)",
      "  BITBUCKET_MCP_LOG_LEVEL       debug|info|warn|error (default: info)",
      "",
    ].join("\n"),
  );
  return 0;
}

function parseCallbackPort(raw: string | undefined): number {
  if (!raw) return DEFAULT_CALLBACK_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ConfigError(
      `BITBUCKET_MCP_CALLBACK_PORT must be an integer in 1..65535, got: ${raw}`,
    );
  }
  return n;
}

/** Convert an error thrown by a command into a process exit code + stderr line. */
export function reportError(err: unknown): number {
  if (err instanceof ConfigError) {
    process.stderr.write(`Config error: ${err.message}\n`);
    return 2;
  }
  if (err instanceof AuthError) {
    process.stderr.write(`Auth error: ${err.message}\n`);
    return 2;
  }
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`Unhandled error: ${message}\n`);
  return 1;
}
