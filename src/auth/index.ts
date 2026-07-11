/**
 * Auth module entry point.
 *
 * `createDefaultVault` picks the right OS-native encrypted-secret
 * backend for the host platform — DPAPI on Windows, Keychain on macOS,
 * Secret Service (libsecret) elsewhere. `createDefaultTokenStore`
 * layers token JSON on top of it.
 */

import { getAppPaths } from "../paths.js";
import { DpapiVault } from "./dpapi-vault.js";
import { KeychainVault } from "./keychain-vault.js";
import { LibsecretVault } from "./libsecret-vault.js";
import type { SecretVault } from "./secret-vault.js";
import type { TokenStore } from "./token-store.js";
import { VaultTokenStore } from "./vault-token-store.js";

export type { StoredToken, TokenStore } from "./token-store.js";
export type { SecretVault } from "./secret-vault.js";

export function createDefaultVault(): SecretVault {
  if (process.platform === "win32") {
    return new DpapiVault({ configDir: getAppPaths().configDir });
  }
  if (process.platform === "darwin") {
    return new KeychainVault();
  }
  return new LibsecretVault();
}

export function createDefaultTokenStore(): TokenStore {
  return new VaultTokenStore(createDefaultVault());
}
