/**
 * OS-specific paths for config and token storage.
 *
 * Windows is the priority platform; we use %APPDATA%\bitbucket-mcp by
 * default. On macOS and Linux we follow XDG conventions as best-effort —
 * cross-platform support is not yet fully wired (see ROADMAP open
 * question #3), but file layout is consistent so the encryption work is
 * the only remaining gap.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export interface AppPaths {
  /** Directory holding config.json and tokens.bin. Created on first write. */
  readonly configDir: string;
  readonly configFile: string;
  /** Encrypted token blob. Format depends on platform store implementation. */
  readonly tokenFile: string;
}

function configRoot(): string {
  if (process.platform === "win32") {
    const appData = process.env["APPDATA"];
    if (appData) return join(appData, "bitbucket-mcp");
    return join(homedir(), "AppData", "Roaming", "bitbucket-mcp");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "bitbucket-mcp");
  }
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg) return join(xdg, "bitbucket-mcp");
  return join(homedir(), ".config", "bitbucket-mcp");
}

export function getAppPaths(): AppPaths {
  const configDir = configRoot();
  return {
    configDir,
    configFile: join(configDir, "config.json"),
    tokenFile: join(configDir, "tokens.bin"),
  };
}
