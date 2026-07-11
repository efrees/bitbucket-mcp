/**
 * Windows DPAPI-backed SecretVault.
 *
 * Uses Windows Data Protection API via a short-lived `powershell.exe`
 * subprocess. PowerShell ships with Windows 10/11, so no native npm
 * module is required and nothing needs to compile on install. DPAPI
 * with `CurrentUser` scope means the ciphertext is decryptable only by
 * the same Windows user on the same machine.
 *
 * Vault operations are infrequent — a handful of reads/writes per
 * session — so the ~100ms spawn cost is acceptable in exchange for
 * zero build-time dependencies.
 *
 * Each key is stored as `<configDir>\<key>.bin` holding the raw DPAPI
 * ciphertext bytes of the UTF-8 value. Nothing else (no header, no
 * base64) — this matches the pre-vault token file format, so existing
 * `tokens.bin` files remain readable.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AuthError } from "../errors.js";
import type { SecretVault, ToolRunner } from "./secret-vault.js";
import { assertValidVaultKey, runTool } from "./secret-vault.js";

const PROTECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd().Trim()
$plain = [Convert]::FromBase64String($in)
$cipher = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, 'CurrentUser')
[Console]::Out.Write([Convert]::ToBase64String($cipher))
`;

const UNPROTECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd().Trim()
$cipher = [Convert]::FromBase64String($in)
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, 'CurrentUser')
[Console]::Out.Write([Convert]::ToBase64String($plain))
`;

export interface DpapiVaultOptions {
  readonly configDir: string;
  /** Test hook; defaults to spawning powershell.exe. */
  readonly run?: ToolRunner;
}

export class DpapiVault implements SecretVault {
  public readonly backendName = "Windows DPAPI";
  private readonly configDir: string;
  private readonly run: ToolRunner;

  constructor(options: DpapiVaultOptions) {
    if (process.platform !== "win32" && !options.run) {
      throw new AuthError(
        `DpapiVault only works on Windows (current platform: ${process.platform}).`,
      );
    }
    this.configDir = options.configDir;
    this.run = options.run ?? runTool;
  }

  public async get(key: string): Promise<string | null> {
    let cipher: Buffer;
    try {
      cipher = await readFile(this.fileFor(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    if (cipher.length === 0) return null;
    const plain = await this.powershell(UNPROTECT_SCRIPT, cipher.toString("base64"));
    return Buffer.from(plain, "base64").toString("utf8");
  }

  public async set(key: string, value: string): Promise<void> {
    const cipher = await this.powershell(
      PROTECT_SCRIPT,
      Buffer.from(value, "utf8").toString("base64"),
    );
    await mkdir(this.configDir, { recursive: true });
    await writeFile(this.fileFor(key), Buffer.from(cipher, "base64"));
  }

  public async delete(key: string): Promise<void> {
    await rm(this.fileFor(key), { force: true });
  }

  private fileFor(key: string): string {
    assertValidVaultKey(key);
    return join(this.configDir, `${key}.bin`);
  }

  private async powershell(script: string, stdinBase64: string): Promise<string> {
    const result = await this.run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      stdinBase64,
    );
    if (result.code !== 0) {
      throw new AuthError(`DPAPI operation failed (exit ${result.code}): ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
  }
}
