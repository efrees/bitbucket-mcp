/**
 * macOS Keychain-backed SecretVault.
 *
 * Uses the OS-bundled `/usr/bin/security` CLI against the user's login
 * keychain — no native npm module, nothing to compile on install. Items
 * are generic passwords under service "bitbucket-mcp", one per vault key.
 *
 * Values are stored base64-encoded so arbitrary JSON (quotes, newlines)
 * survives the CLI round trip unmangled.
 *
 * Writes go through `security -i` with the subcommand fed over stdin
 * rather than `security add-generic-password -w <secret>` as argv:
 * argv is visible to every process on the machine via `ps` for the
 * lifetime of the subprocess, stdin is not. Because `-i` mode's exit
 * code is not a reliable failure signal across macOS versions, set()
 * reads the value back and verifies it before returning.
 */

import { AuthError } from "../errors.js";
import type { SecretVault, ToolRunner } from "./secret-vault.js";
import { assertValidVaultKey, runTool } from "./secret-vault.js";

const SERVICE = "bitbucket-mcp";

/** `security` exit status for errSecItemNotFound. */
const EXIT_ITEM_NOT_FOUND = 44;

export interface KeychainVaultOptions {
  /** Test hook; defaults to spawning /usr/bin/security. */
  readonly run?: ToolRunner;
}

export class KeychainVault implements SecretVault {
  public readonly backendName = "macOS Keychain";
  private readonly run: ToolRunner;

  constructor(options: KeychainVaultOptions = {}) {
    this.run = options.run ?? runTool;
  }

  public async get(key: string): Promise<string | null> {
    assertValidVaultKey(key);
    const result = await this.security(
      ["find-generic-password", "-s", SERVICE, "-a", key, "-w"],
    );
    if (isNotFound(result.code, result.stderr)) return null;
    if (result.code !== 0) {
      throw new AuthError(
        `Keychain read failed (exit ${result.code}): ${result.stderr.trim()}`,
      );
    }
    return Buffer.from(result.stdout.trim(), "base64").toString("utf8");
  }

  public async set(key: string, value: string): Promise<void> {
    assertValidVaultKey(key);
    const encoded = Buffer.from(value, "utf8").toString("base64");
    // -U updates in place if the item already exists.
    const command = `add-generic-password -U -s "${SERVICE}" -a "${key}" -w "${encoded}"\n`;
    const result = await this.security(["-i"], command);
    if (result.code !== 0) {
      throw new AuthError(
        `Keychain write failed (exit ${result.code}): ${result.stderr.trim()}`,
      );
    }
    const readBack = await this.get(key);
    if (readBack !== value) {
      throw new AuthError(
        "Keychain write did not verify: the value read back does not match what was written.",
      );
    }
  }

  public async delete(key: string): Promise<void> {
    assertValidVaultKey(key);
    const result = await this.security(["delete-generic-password", "-s", SERVICE, "-a", key]);
    if (result.code === 0 || isNotFound(result.code, result.stderr)) return;
    throw new AuthError(
      `Keychain delete failed (exit ${result.code}): ${result.stderr.trim()}`,
    );
  }

  private async security(args: readonly string[], stdin?: string) {
    try {
      return await this.run("security", args, stdin);
    } catch (err) {
      throw new AuthError(
        `Could not run the macOS \`security\` tool: ${(err as Error).message}`,
      );
    }
  }
}

function isNotFound(code: number, stderr: string): boolean {
  return code === EXIT_ITEM_NOT_FOUND || /could not be found/i.test(stderr);
}
