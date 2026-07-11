/**
 * SecretVault — OS-native encrypted storage for small secrets.
 *
 * A vault maps a short key (e.g. "tokens") to a secret string, protected
 * at rest by the platform's credential facility. All backends shell out
 * to OS-bundled tools rather than depending on native npm modules, so
 * nothing has to compile on the user's machine. Secret material moves
 * over stdin/stdout only — never on a command line — so it can't leak
 * into process listings.
 *
 * `createDefaultVault()` (in ./index.ts) picks the backend for the host
 * platform.
 */

import { spawn } from "node:child_process";

export interface SecretVault {
  /** Human-readable backend label for user-facing messages. */
  readonly backendName: string;
  /** Returns the stored secret, or null if the key has never been set. */
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Vault keys are internal constants, but they end up in file names and
 * keychain item attributes, so keep them to a conservative charset.
 */
export function assertValidVaultKey(key: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(key)) {
    throw new Error(`Invalid vault key "${key}" (expected lowercase kebab-case).`);
  }
}

export interface ToolResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ToolRunner = (command: string, args: readonly string[], stdin?: string) => Promise<ToolResult>;

/**
 * Run an OS credential tool, feeding `stdin` and capturing both streams.
 * Resolves with the exit code rather than rejecting on non-zero, because
 * "not found" is an expected outcome the backends must inspect. Rejects
 * only if the process can't be spawned at all (e.g. tool not installed).
 */
export const runTool: ToolRunner = (command, args, stdin) =>
  new Promise((resolve, reject) => {
    const proc = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });

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
      resolve({ code: code ?? -1, stdout, stderr });
    });

    proc.stdin.end(stdin ?? "");
  });
