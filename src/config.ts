/**
 * Config loader.
 *
 * Reads the user's OAuth consumer `client_id` and optional defaults from
 * `<configDir>/config.json` or env vars (env overrides file, so CI and
 * ad-hoc overrides don't require editing the file).
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
import { ConfigError } from "./errors.js";
import { getAppPaths } from "./paths.js";

export interface AppConfig {
  /** OAuth consumer key (the "client_id" in OAuth terms). Required for login. */
  readonly clientId: string;
  /**
   * OAuth consumer secret. Required by Bitbucket at the token endpoint
   * even when PKCE is in use, so we persist it alongside the key.
   * Living on the user's own machine in the user's config dir keeps the
   * exposure footprint to their own OS user account.
   */
  readonly clientSecret: string;
  /** Optional default workspace slug used when tools are called without one. */
  readonly defaultWorkspace: string | undefined;
}

interface RawConfig {
  clientId?: unknown;
  clientSecret?: unknown;
  defaultWorkspace?: unknown;
}

function readConfigFile(path: string): RawConfig {
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

/**
 * Load the config from disk + env. Throws `ConfigError` if required fields
 * are missing — callers can catch and present a user-friendly setup message.
 */
export function loadConfig(): AppConfig {
  const paths = getAppPaths();
  const file = readConfigFile(paths.configFile);

  const clientId = process.env["BITBUCKET_MCP_CLIENT_ID"] ?? file.clientId;
  const clientSecret = process.env["BITBUCKET_MCP_CLIENT_SECRET"] ?? file.clientSecret;
  const defaultWorkspace = process.env["BITBUCKET_MCP_WORKSPACE"] ?? file.defaultWorkspace;

  if (typeof clientId !== "string" || clientId.length === 0) {
    throw new ConfigError(
      `Missing OAuth client_id. Register an OAuth consumer in your Bitbucket workspace, ` +
        `then set BITBUCKET_MCP_CLIENT_ID or put {"clientId": "..."} in ${paths.configFile}.`,
    );
  }
  if (typeof clientSecret !== "string" || clientSecret.length === 0) {
    throw new ConfigError(
      `Missing OAuth client_secret. Bitbucket requires the secret at the token endpoint ` +
        `even with PKCE. Copy the Secret from your OAuth consumer and set ` +
        `BITBUCKET_MCP_CLIENT_SECRET or add {"clientSecret": "..."} to ${paths.configFile}.`,
    );
  }

  return {
    clientId,
    clientSecret,
    defaultWorkspace:
      typeof defaultWorkspace === "string" && defaultWorkspace.length > 0
        ? defaultWorkspace
        : undefined,
  };
}
