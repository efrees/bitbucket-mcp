import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { SecretVault } from "../src/auth/secret-vault.ts";
import type { StoredToken } from "../src/auth/token-store.ts";
import { TOKENS_VAULT_KEY, VaultTokenStore } from "../src/auth/vault-token-store.ts";
import { AuthError } from "../src/errors.ts";

function memoryVault(initial: Record<string, string> = {}): SecretVault & {
  readonly entries: Map<string, string>;
} {
  const entries = new Map(Object.entries(initial));
  return {
    backendName: "in-memory (test)",
    entries,
    get: async (key) => entries.get(key) ?? null,
    set: async (key, value) => {
      entries.set(key, value);
    },
    delete: async (key) => {
      entries.delete(key);
    },
  };
}

const SAMPLE: StoredToken = {
  accessToken: "at-1",
  refreshToken: "rt-1",
  expiresAt: 1_750_000_000_000,
  scopes: "account repository pullrequest",
  user: { uuid: "{u}", displayName: "Test User", accountId: "a-1" },
};

test("save/load roundtrips a StoredToken through the vault", async () => {
  const vault = memoryVault();
  const store = new VaultTokenStore(vault);

  await store.save(SAMPLE);
  assert.ok(vault.entries.has(TOKENS_VAULT_KEY), "token JSON stored under the tokens key");

  const loaded = await store.load();
  assert.deepEqual(loaded, SAMPLE);
});

test("load returns null when the vault has no tokens", async () => {
  const store = new VaultTokenStore(memoryVault());
  assert.equal(await store.load(), null);
});

test("load throws AuthError on corrupt stored JSON", async () => {
  const store = new VaultTokenStore(memoryVault({ [TOKENS_VAULT_KEY]: "not json{" }));
  await assert.rejects(() => store.load(), AuthError);
});

test("clear removes the tokens entry", async () => {
  const vault = memoryVault();
  const store = new VaultTokenStore(vault);
  await store.save(SAMPLE);
  await store.clear();
  assert.equal(await store.load(), null);
  assert.equal(vault.entries.size, 0);
});
