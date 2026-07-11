import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DpapiVault } from "../src/auth/dpapi-vault.ts";

// Real DPAPI roundtrip — Windows only (CI runs windows-latest). The
// PowerShell subprocess costs ~100ms per op, so keep this to one test.
test(
  "DpapiVault roundtrips a value through real DPAPI",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "bbmcp-vault-"));
    try {
      const vault = new DpapiVault({ configDir: dir });

      assert.equal(await vault.get("tokens"), null, "missing key reads as null");

      const value = JSON.stringify({ secret: "s3cret-value", n: 42 });
      await vault.set("tokens", value);
      assert.equal(await vault.get("tokens"), value);

      await vault.delete("tokens");
      assert.equal(await vault.get("tokens"), null);
      await vault.delete("tokens"); // idempotent
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("vault keys are restricted to kebab-case", async () => {
  const vault = new DpapiVault({
    configDir: ".",
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  await assert.rejects(() => vault.get("../evil"), /Invalid vault key/);
  await assert.rejects(() => vault.set("Bad Key", "x"), /Invalid vault key/);
});
