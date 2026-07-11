/**
 * Config loader.
 *
 * Non-secret settings (`authMode`, `clientId`, `defaultWorkspace`) come
 * from `<configDir>/config.json` or env vars (env overrides file, so CI
 * and ad-hoc overrides don't require editing the file).
 *
 * The OAuth `clientSecret` is a live credential and is resolved with a
 * different precedence: env var, then the OS secret vault (populated by
 * `bitbucket-mcp set-secret`), then — deprecated, with a warning — a
 * plaintext `clientSecret` field in config.json. The plaintext path
 * exists only so pre-vault setups keep working while they migrate.
 *
 * A minimal config looks like:
 *
 * ```json
 * {
 *   "clientId": "abc123...",
 *   "defaultWorkspace": "my-workspace"
 * }
 * ```
 */

import { readFileSync } from "node:fs";
import { createDefaultVault } from "./auth/index.js";
import type { SecretVault } from "./auth/index.js";
import { DEFAULT_CALLBACK_PORT } from "./auth/login-flow.js";
import { ConfigError } from "./errors.js";
import { log } from "./logger.js";
import { getAppPaths } from "./paths.js";

/** Vault key under which `set-secret` stores the OAuth consumer secret. */
export const CLIENT_SECRET_VAULT_KEY = "client-secret";

/**
 * Auth mode the server runs in.
 *
 *  - `"client_credentials"` — headless flow: no browser, no callback,
 *    no refresh tokens. Actions are attributed to the OAuth consumer
 *    itself rather than to a specific Bitbucket user. Default.
 *  - `"authorization_code"` — interactive 3LO flow: the user logs in
 *    via browser once, tokens are persisted in the OS secret vault, and
 *    actions are attributed to the human user who consented.
 */
export type AuthMode = "client_credentials" | "authorization_code";

export interface AppConfig {
  /** Which OAuth flow to use at runtime. Default: client_credentials. */
  readonly authMode: AuthMode;
  /** OAuth consumer key (the "client_id" in OAuth terms). Required. */
  readonly clientId: string;
  /**
   * OAuth consumer secret. Required by Bitbucket at the token endpoint
   * in both auth modes. Resolved from env / OS vault / config.json —
   * see the module doc comment for precedence.
   */
  readonly clientSecret: string;
  /** Optional default workspace slug used when tools are called without one. */
  readonly defaultWorkspace: string | undefined;
  /**
   * Loopback port for the 3LO OAuth callback (authorization_code mode).
   * Must match the port registered on the Bitbucket consumer's callback
   * URL exactly. Default: 33378 (see DEFAULT_CALLBACK_PORT rationale).
   */
  readonly callbackPort: number;
}

export interface RawConfig {
  authMode?: unknown;
  clientId?: unknown;
  clientSecret?: unknown;
  defaultWorkspace?: unknown;
  callbackPort?: unknown;
}

export function readConfigFile(path: string): RawConfig {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") {
      throw new ConfigError(`Config file ${path} is not a JSON object.`);
    }
    return parsed as RawConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`Failed to read config file ${path}: ${(err as Error).message}`);
  }
}

/** True if config.json still carries a plaintext clientSecret (deprecated). */
export function configFileHasPlaintextSecret(): boolean {
  const file = readConfigFile(getAppPaths().configFile);
  return typeof file.clientSecret === "string" && file.clientSecret.length > 0;
}

/**
 * Load the config from disk + env + OS vault. Throws `ConfigError` if
 * required fields are missing — callers can catch and present a
 * user-friendly setup message.
 *
 * `vault` is injectable for tests; production callers omit it. The
 * vault is only consulted when the env var doesn't already supply the
 * secret, so headless setups never pay the subprocess cost.
 */
export async function loadConfig(vault?: SecretVault): Promise<AppConfig> {
  const paths = getAppPaths();
  const file = readConfigFile(paths.configFile);

  const rawAuthMode = process.env["BITBUCKET_MCP_AUTH_MODE"] ?? file.authMode;
  const clientId = process.env["BITBUCKET_MCP_CLIENT_ID"] ?? file.clientId;
  const defaultWorkspace = process.env["BITBUCKET_MCP_WORKSPACE"] ?? file.defaultWorkspace;
  const rawCallbackPort = process.env["BITBUCKET_MCP_CALLBACK_PORT"] ?? file.callbackPort;

  const authMode = parseAuthMode(rawAuthMode);
  const callbackPort = parseCallbackPort(rawCallbackPort);

  if (typeof clientId !== "string" || clientId.length === 0) {
    throw new ConfigError(
      `Missing OAuth client_id. Register an OAuth consumer in your Bitbucket workspace, ` +
        `then set BITBUCKET_MCP_CLIENT_ID or put {"clientId": "..."} in ${paths.configFile}.`,
    );
  }

  const clientSecret = await resolveClientSecret(file, paths.configFile, vault);

  return {
    authMode,
    clientId,
    clientSecret,
    defaultWorkspace:
      typeof defaultWorkspace === "string" && defaultWorkspace.length > 0
        ? defaultWorkspace
        : undefined,
    callbackPort,
  };
}

async function resolveClientSecret(
  file: RawConfig,
  configFilePath: string,
  vault: SecretVault | undefined,
): Promise<string> {
  const fromEnv = process.env["BITBUCKET_MCP_CLIENT_SECRET"];
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;

  try {
    const activeVault = vault ?? createDefaultVault();
    const stored = await activeVault.get(CLIENT_SECRET_VAULT_KEY);
    if (stored !== null && stored.length > 0) return stored;
  } catch (err) {
    // A broken vault (e.g. no Secret Service on a headless box) must not
    // strand users who have the secret elsewhere — warn and keep resolving.
    log.warn("config: could not read client secret from the OS vault", {
      error: (err as Error).message,
    });
  }

  if (typeof file.clientSecret === "string" && file.clientSecret.length > 0) {
    log.warn(
      "config: clientSecret is stored in PLAINTEXT in config.json (deprecated). " +
        "Run `bitbucket-mcp set-secret` to move it into the OS secret store, " +
        "then delete the clientSecret line from the file.",
      { file: configFilePath },
    );
    return file.clientSecret;
  }

  throw new ConfigError(
    `Missing OAuth client_secret. Bitbucket requires the secret at the token endpoint ` +
      `even with PKCE. Copy the Secret from your OAuth consumer, then store it with ` +
      `\`bitbucket-mcp set-secret\` (recommended) or set BITBUCKET_MCP_CLIENT_SECRET.`,
  );
}

function parseCallbackPort(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_CALLBACK_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ConfigError(
      `callbackPort / BITBUCKET_MCP_CALLBACK_PORT must be an integer in 1..65535, got: ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

function parseAuthMode(raw: unknown): AuthMode {
  if (raw === undefined || raw === null || raw === "") return "client_credentials";
  if (raw === "client_credentials" || raw === "authorization_code") return raw;
  throw new ConfigError(
    `authMode must be "client_credentials" or "authorization_code", got: ${JSON.stringify(raw)}`,
  );
}
