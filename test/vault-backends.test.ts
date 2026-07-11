import { strict as assert } from "node:assert";
import { test } from "node:test";
import { KeychainVault } from "../src/auth/keychain-vault.ts";
import { LibsecretVault } from "../src/auth/libsecret-vault.ts";
import type { ToolResult } from "../src/auth/secret-vault.ts";
import { AuthError } from "../src/errors.ts";

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: string | undefined;
}

/** Fake ToolRunner that scripts one result per successive call. */
function scriptedRunner(results: ToolResult[]) {
  const calls: Call[] = [];
  const run = async (command: string, args: readonly string[], stdin?: string) => {
    calls.push({ command, args, stdin });
    const next = results.shift();
    if (!next) throw new Error("scriptedRunner: no result scripted for this call");
    return next;
  };
  return { run, calls };
}

const ok = (stdout = ""): ToolResult => ({ code: 0, stdout, stderr: "" });
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

// --- KeychainVault ---

test("KeychainVault.get decodes the stored base64 value", async () => {
  const { run, calls } = scriptedRunner([ok(`${b64("hello world")}\n`)]);
  const vault = new KeychainVault({ run });

  assert.equal(await vault.get("client-secret"), "hello world");
  assert.deepEqual(calls[0]?.args, [
    "find-generic-password", "-s", "bitbucket-mcp", "-a", "client-secret", "-w",
  ]);
});

test("KeychainVault.get maps errSecItemNotFound (exit 44) to null", async () => {
  const { run } = scriptedRunner([
    { code: 44, stdout: "", stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." },
  ]);
  assert.equal(await new KeychainVault({ run }).get("tokens"), null);
});

test("KeychainVault.set keeps the secret off argv and verifies the write", async () => {
  const value = 'json {"a":1}\nwith newline';
  const { run, calls } = scriptedRunner([ok(), ok(`${b64(value)}\n`)]);
  const vault = new KeychainVault({ run });

  await vault.set("client-secret", value);

  assert.equal(calls.length, 2, "one write + one verify read");
  const write = calls[0]!;
  assert.deepEqual(write.args, ["-i"], "write goes through `security -i` stdin mode");
  assert.ok(write.stdin?.includes(b64(value)), "stdin carries the encoded value");
  assert.ok(
    !write.args.some((a) => a.includes(b64(value))),
    "encoded secret must not appear in argv",
  );
});

test("KeychainVault.set throws when the verify read-back mismatches", async () => {
  const { run } = scriptedRunner([ok(), ok(`${b64("something else")}\n`)]);
  await assert.rejects(
    () => new KeychainVault({ run }).set("client-secret", "expected"),
    /did not verify/,
  );
});

// --- LibsecretVault ---

test("LibsecretVault.get maps silent exit 1 to null", async () => {
  const { run } = scriptedRunner([{ code: 1, stdout: "", stderr: "" }]);
  assert.equal(await new LibsecretVault({ run }).get("tokens"), null);
});

test("LibsecretVault.get decodes and surfaces real errors", async () => {
  const { run, calls } = scriptedRunner([ok(b64("s3cret"))]);
  const vault = new LibsecretVault({ run });
  assert.equal(await vault.get("client-secret"), "s3cret");
  assert.deepEqual(calls[0]?.args, ["lookup", "service", "bitbucket-mcp", "key", "client-secret"]);

  const failing = scriptedRunner([{ code: 1, stdout: "", stderr: "cannot connect to dbus" }]);
  await assert.rejects(
    () => new LibsecretVault({ run: failing.run }).get("client-secret"),
    /Secret Service read failed/,
  );
});

test("LibsecretVault.set passes the secret via stdin only", async () => {
  const { run, calls } = scriptedRunner([ok()]);
  await new LibsecretVault({ run }).set("client-secret", "top-secret");

  const call = calls[0]!;
  assert.equal(call.stdin, b64("top-secret"));
  assert.ok(!call.args.some((a) => a.includes(b64("top-secret"))), "secret not in argv");
  assert.ok(call.args.includes("store"));
});

test("LibsecretVault reports a missing secret-tool with install guidance", async () => {
  const enoent = async () => {
    const err: NodeJS.ErrnoException = new Error("spawn secret-tool ENOENT");
    err.code = "ENOENT";
    throw err;
  };
  await assert.rejects(
    () => new LibsecretVault({ run: enoent }).get("tokens"),
    (err: unknown) =>
      err instanceof AuthError && /libsecret-tools/.test(err.message),
  );
});
