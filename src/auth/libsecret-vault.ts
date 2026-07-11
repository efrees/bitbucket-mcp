/**
 * Linux Secret Service (libsecret)-backed SecretVault.
 *
 * Uses the `secret-tool` CLI (package `libsecret-tools` on Debian/Ubuntu,
 * `libsecret` on Fedora/Arch) talking to the running Secret Service
 * (GNOME Keyring, KWallet 5.97+, etc.) over D-Bus. No native npm module,
 * nothing to compile on install.
 *
 * Items are keyed by the attribute pair (service=bitbucket-mcp, key=<key>).
 * Values are stored base64-encoded so arbitrary JSON survives the CLI
 * round trip; `secret-tool store` reads the secret from stdin, which
 * keeps it out of `ps` output.
 *
 * Headless boxes usually have no Secret Service; the error below points
 * at the env-var escape hatch documented in docs/setup.md.
 */

import { AuthError } from "../errors.js";
import type { SecretVault, ToolRunner } from "./secret-vault.js";
import { assertValidVaultKey, runTool } from "./secret-vault.js";

const SERVICE = "bitbucket-mcp";

export interface LibsecretVaultOptions {
  /** Test hook; defaults to spawning secret-tool. */
  readonly run?: ToolRunner;
}

export class LibsecretVault implements SecretVault {
  public readonly backendName = "Linux Secret Service (libsecret)";
  private readonly run: ToolRunner;

  constructor(options: LibsecretVaultOptions = {}) {
    this.run = options.run ?? runTool;
  }

  public async get(key: string): Promise<string | null> {
    assertValidVaultKey(key);
    const result = await this.secretTool(["lookup", "service", SERVICE, "key", key]);
    // `secret-tool lookup` exits 1 with no stderr when nothing matches.
    if (result.code !== 0) {
      if (result.stderr.trim() === "") return null;
      throw new AuthError(this.describeFailure("read", result.code, result.stderr));
    }
    return Buffer.from(result.stdout.trim(), "base64").toString("utf8");
  }

  public async set(key: string, value: string): Promise<void> {
    assertValidVaultKey(key);
    const encoded = Buffer.from(value, "utf8").toString("base64");
    const result = await this.secretTool(
      ["store", `--label=${SERVICE} ${key}`, "service", SERVICE, "key", key],
      encoded,
    );
    if (result.code !== 0) {
      throw new AuthError(this.describeFailure("write", result.code, result.stderr));
    }
  }

  public async delete(key: string): Promise<void> {
    assertValidVaultKey(key);
    const result = await this.secretTool(["clear", "service", SERVICE, "key", key]);
    // `clear` exits 0 whether or not anything matched; treat a silent
    // non-zero the same as not-found for idempotency.
    if (result.code !== 0 && result.stderr.trim() !== "") {
      throw new AuthError(this.describeFailure("delete", result.code, result.stderr));
    }
  }

  private async secretTool(args: readonly string[], stdin?: string) {
    try {
      return await this.run("secret-tool", args, stdin);
    } catch (err) {
      const cause = (err as NodeJS.ErrnoException).code === "ENOENT"
        ? "`secret-tool` is not installed"
        : (err as Error).message;
      throw new AuthError(
        `Could not run secret-tool: ${cause}. Install libsecret ` +
          `(Debian/Ubuntu: \`apt install libsecret-tools\`) and make sure a Secret Service ` +
          `(GNOME Keyring / KWallet) is running. On headless machines, use the ` +
          `BITBUCKET_MCP_CLIENT_SECRET environment variable instead (see docs/setup.md).`,
      );
    }
  }

  private describeFailure(op: string, code: number, stderr: string): string {
    return (
      `Secret Service ${op} failed (exit ${code}): ${stderr.trim()}. ` +
      `Make sure a Secret Service (GNOME Keyring / KWallet) is running and unlocked. ` +
      `On headless machines, use the BITBUCKET_MCP_CLIENT_SECRET environment variable ` +
      `instead (see docs/setup.md).`
    );
  }
}
