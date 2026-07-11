/**
 * CLI subcommand handlers.
 *
 * The default invocation (no subcommand) starts the MCP stdio server.
 * The named subcommands are user-facing setup/diagnostic tools:
 *
 *   bitbucket-mcp login         — run OAuth 3LO and persist tokens (auth_code mode only)
 *   bitbucket-mcp logout        — wipe stored tokens (auth_code mode only)
 *   bitbucket-mcp whoami        — describe the current auth state
 *   bitbucket-mcp set-secret    — store the OAuth consumer secret in the OS vault
 *   bitbucket-mcp clear-secret  — remove the stored consumer secret
 *
 * These commands write human-readable output to stdout (safe: they never
 * speak MCP protocol). Errors go to stderr and exit non-zero so shell
 * scripts can gate on them.
 */

import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { ClientCredentialsAuth } from "../auth/client-credentials-auth.js";
import { createDefaultTokenStore, createDefaultVault } from "../auth/index.js";
import { performLogin } from "../auth/login-flow.js";
import { AuthSession } from "../auth/session.js";
import { CLIENT_SECRET_VAULT_KEY, configFileHasPlaintextSecret, loadConfig } from "../config.js";
import type { AppConfig } from "../config.js";
import { AuthError, ConfigError } from "../errors.js";

export async function runLogin(): Promise<number> {
  const config = await loadConfig();
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

  const callbackPort = config.callbackPort;
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
  const config = await loadConfig();
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
  const config = await loadConfig();
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

export async function runSetSecret(): Promise<number> {
  const vault = createDefaultVault();
  const secret = await readSecretInput();
  if (!secret) {
    process.stderr.write("No secret provided; nothing stored.\n");
    return 2;
  }
  await vault.set(CLIENT_SECRET_VAULT_KEY, secret);
  process.stdout.write(`Client secret stored in the OS secret vault (${vault.backendName}).\n`);
  if (configFileHasPlaintextSecret()) {
    process.stdout.write(
      "Note: config.json still contains a plaintext clientSecret. The vault copy now " +
        "takes precedence — delete the clientSecret line from config.json.\n",
    );
  }
  return 0;
}

export async function runClearSecret(): Promise<number> {
  const vault = createDefaultVault();
  await vault.delete(CLIENT_SECRET_VAULT_KEY);
  process.stdout.write(
    `Client secret removed from the OS secret vault (${vault.backendName}), if it was set.\n`,
  );
  return 0;
}

/**
 * Read the secret without echoing it. On a TTY, readline is pointed at a
 * muted output stream so keystrokes aren't reflected; when piped
 * (`echo $SECRET | bitbucket-mcp set-secret`), read stdin to EOF.
 */
async function readSecretInput(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write("Paste your OAuth consumer secret (input hidden): ");
    const muted = new Writable({ write: (_chunk, _enc, cb) => cb() });
    const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
    try {
      const answer = await rl.question("");
      process.stderr.write("\n");
      return answer.trim();
    } finally {
      rl.close();
    }
  }
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data.trim();
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
      "  bitbucket-mcp set-secret          store the OAuth consumer secret in the OS vault",
      "  bitbucket-mcp clear-secret        remove the stored consumer secret",
      "  bitbucket-mcp help                show this message",
      "",
      "Config:",
      "  BITBUCKET_MCP_AUTH_MODE       client_credentials (default) | authorization_code",
      "  BITBUCKET_MCP_CLIENT_ID       OAuth consumer key (required)",
      "  BITBUCKET_MCP_CLIENT_SECRET   OAuth consumer secret (overrides the OS-vault copy)",
      "  BITBUCKET_MCP_WORKSPACE       default workspace slug (optional)",
      "  BITBUCKET_MCP_CALLBACK_PORT   loopback port for OAuth callback (default: 33378)",
      "  BITBUCKET_MCP_LOG_LEVEL       debug|info|warn|error (default: info)",
      "",
    ].join("\n"),
  );
  return 0;
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
