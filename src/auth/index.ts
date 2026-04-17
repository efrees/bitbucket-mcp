/**
 * Auth module entry point.
 *
 * `createDefaultTokenStore` picks the right encrypted-at-rest backend for
 * the host OS. Windows uses DPAPI; other platforms currently throw (see
 * ROADMAP open question #3).
 */

import { AuthError } from "../errors.js";
import { getAppPaths } from "../paths.js";
import { DpapiTokenStore } from "./dpapi-token-store.js";
import type { TokenStore } from "./token-store.js";

export type { StoredToken, TokenStore } from "./token-store.js";

export function createDefaultTokenStore(): TokenStore {
  const paths = getAppPaths();
  if (process.platform === "win32") {
    return new DpapiTokenStore({ tokenFile: paths.tokenFile });
  }
  throw new AuthError(
    `No token-store backend is configured for platform "${process.platform}". ` +
      `Windows (DPAPI) is the only supported target in the current release.`,
  );
}
