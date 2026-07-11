import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SecretVault } from "../src/auth/secret-vault.ts";
import { CLIENT_SECRET_VAULT_KEY, loadConfig } from "../src/config.ts";
import { ConfigError } from "../src/errors.ts";
import { getAppPaths } from "../src/paths.ts";

const MANAGED_ENV = [
  "BITBUCKET_MCP_AUTH_MODE",
  "BITBUCKET_MCP_CLIENT_ID",
  "BITBUCKET_MCP_CLIENT_SECRET",
  "BITBUCKET_MCP_WORKSPACE",
  "APPDATA",
  "XDG_CONFIG_HOME",
  "HOME",
] as const;

/**
 * Run `fn` with the config dir redirected to a temp root and all
 * BITBUCKET_MCP_* env vars cleared, restoring everything afterwards.
 * Redirecting APPDATA / XDG_CONFIG_HOME / HOME covers the config-root
 * lookup on all three platforms.
 */
async function withIsolatedConfig(
  fileContents: object | null,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = new Map(MANAGED_ENV.map((k) => [k, process.env[k]]));
  const root = mkdtempSync(join(tmpdir(), "bbmcp-config-"));
  try {
    for (const key of MANAGED_ENV) delete process.env[key];
    process.env["APPDATA"] = root;
    process.env["XDG_CONFIG_HOME"] = root;
    process.env["HOME"] = root;

    if (fileContents !== null) {
      const paths = getAppPaths();
      mkdirSync(paths.configDir, { recursive: true });
      writeFileSync(paths.configFile, JSON.stringify(fileContents));
    }
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function fakeVault(secret: string | null): SecretVault {
  return {
    backendName: "in-memory (test)",
    get: async (key) => (key === CLIENT_SECRET_VAULT_KEY ? secret : null),
    set: async () => {},
    delete: async () => {},
  };
}

function throwingVault(): SecretVault {
  return {
    backendName: "broken (test)",
    get: async () => {
      throw new Error("no secret service");
    },
    set: async () => {},
    delete: async () => {},
  };
}

test("env var secret wins and the vault is not needed", async () => {
  await withIsolatedConfig({ clientId: "id-1" }, async () => {
    process.env["BITBUCKET_MCP_CLIENT_SECRET"] = "env-secret";
    const config = await loadConfig(throwingVault());
    assert.equal(config.clientSecret, "env-secret");
  });
});

test("vault secret is used when no env var is set", async () => {
  await withIsolatedConfig({ clientId: "id-1" }, async () => {
    const config = await loadConfig(fakeVault("vault-secret"));
    assert.equal(config.clientSecret, "vault-secret");
    assert.equal(config.authMode, "client_credentials");
  });
});

test("vault secret takes precedence over a plaintext file secret", async () => {
  await withIsolatedConfig({ clientId: "id-1", clientSecret: "file-secret" }, async () => {
    const config = await loadConfig(fakeVault("vault-secret"));
    assert.equal(config.clientSecret, "vault-secret");
  });
});

test("plaintext file secret still works when the vault is empty (deprecated path)", async () => {
  await withIsolatedConfig({ clientId: "id-1", clientSecret: "file-secret" }, async () => {
    const config = await loadConfig(fakeVault(null));
    assert.equal(config.clientSecret, "file-secret");
  });
});

test("a broken vault degrades to the file secret instead of failing", async () => {
  await withIsolatedConfig({ clientId: "id-1", clientSecret: "file-secret" }, async () => {
    const config = await loadConfig(throwingVault());
    assert.equal(config.clientSecret, "file-secret");
  });
});

test("missing secret everywhere raises ConfigError mentioning set-secret", async () => {
  await withIsolatedConfig({ clientId: "id-1" }, async () => {
    await assert.rejects(
      () => loadConfig(fakeVault(null)),
      (err: unknown) => err instanceof ConfigError && /set-secret/.test((err as Error).message),
    );
  });
});

test("missing clientId raises ConfigError before secret resolution", async () => {
  await withIsolatedConfig({}, async () => {
    await assert.rejects(
      () => loadConfig(throwingVault()),
      (err: unknown) => err instanceof ConfigError && /client_id/.test((err as Error).message),
    );
  });
});
