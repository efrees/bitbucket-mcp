/**
 * Windows DPAPI-backed token store.
 *
 * Uses Windows Data Protection API via a short-lived `powershell.exe`
 * subprocess. PowerShell ships with Windows 10/11, so no native npm
 * module is required and nothing needs to compile on install. DPAPI
 * with `CurrentUser` scope means the ciphertext is decryptable only by
 * the same Windows user on the same machine.
 *
 * Token operations are infrequent — one save on login, one load per
 * MCP session start, periodic refresh — so the ~100ms spawn cost is
 * acceptable in exchange for zero build-time dependencies.
 *
 * File format: the file holds the raw DPAPI ciphertext bytes. Nothing
 * else (no header, no base64) — PowerShell reads/writes exact bytes.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AuthError } from "../errors.js";
import type { StoredToken, TokenStore } from "./token-store.js";

interface DpapiTokenStoreOptions {
  readonly tokenFile: string;
}

/** Run a PowerShell snippet with base64-encoded stdin; returns base64 stdout. */
async function runPowershell(script: string, stdinBase64: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new AuthError(`DPAPI operation failed (exit ${code}): ${stderr.trim()}`));
      }
    });

    proc.stdin.end(stdinBase64);
  });
}

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

async function protect(plaintext: Buffer): Promise<Buffer> {
  const out = await runPowershell(PROTECT_SCRIPT, plaintext.toString("base64"));
  return Buffer.from(out, "base64");
}

async function unprotect(ciphertext: Buffer): Promise<Buffer> {
  const out = await runPowershell(UNPROTECT_SCRIPT, ciphertext.toString("base64"));
  return Buffer.from(out, "base64");
}

export class DpapiTokenStore implements TokenStore {
  private readonly tokenFile: string;

  constructor(options: DpapiTokenStoreOptions) {
    if (process.platform !== "win32") {
      throw new AuthError(
        `DpapiTokenStore only works on Windows (current platform: ${process.platform}).`,
      );
    }
    this.tokenFile = options.tokenFile;
  }

  public async load(): Promise<StoredToken | null> {
    let cipher: Buffer;
    try {
      cipher = await readFile(this.tokenFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    if (cipher.length === 0) return null;

    const plain = await unprotect(cipher);
    try {
      const parsed = JSON.parse(plain.toString("utf8")) as StoredToken;
      return parsed;
    } catch (err) {
      throw new AuthError(
        `Token file ${this.tokenFile} decrypted but could not be parsed: ${(err as Error).message}`,
      );
    }
  }

  public async save(token: StoredToken): Promise<void> {
    await mkdir(dirname(this.tokenFile), { recursive: true });
    const plain = Buffer.from(JSON.stringify(token), "utf8");
    const cipher = await protect(plain);
    await writeFile(this.tokenFile, cipher, { mode: 0o600 });
  }

  public async clear(): Promise<void> {
    await rm(this.tokenFile, { force: true });
  }
}
