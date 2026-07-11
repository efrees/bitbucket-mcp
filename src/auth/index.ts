/**
 * Auth module entry point.
 *
 * `createDefaultVault` picks the right OS-native encrypted-secret
 * backend for the host platform; `createDefaultTokenStore` layers token
 * JSON on top of it. Windows uses DPAPI; other platforms currently
 * throw (see ROADMAP open question #3).
 */

import { AuthError } from "../errors.js";
import { getAppPaths } from "../paths.js";
import { DpapiVault } from "./dpapi-vault.js";
import type { SecretVault } from "./secret-vault.js";
import type { TokenStore } from "./token-store.js";
import { VaultTokenStore } from "./vault-token-store.js";

export type { StoredToken, TokenStore } from "./token-store.js";
export type { SecretVault } from "./secret-vault.js";

export function createDefaultVault(): SecretVault {
  const paths = getAppPaths();
  if (process.platform === "win32") {
    return new DpapiVault({ configDir: paths.configDir });
  }
  throw new AuthError(
    `No secret-vault backend is configured for platform "${process.platform}". ` +
      `Windows (DPAPI) is the only supported target in the current release.`,
  );
}

export function createDefaultTokenStore(): TokenStore {
  return new VaultTokenStore(createDefaultVault());
}
