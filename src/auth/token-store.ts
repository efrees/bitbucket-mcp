/**
 * Token persistence interface.
 *
 * Encryption at rest is platform-specific. `TokenStore` is the common
 * shape; `createDefaultTokenStore()` picks the right implementation for
 * the host OS.
 *
 * On Windows this means DPAPI (see ./dpapi-token-store.ts). Other
 * platforms are not yet supported and will throw on construction —
 * see ROADMAP open question #3.
 */

export interface StoredToken {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Unix-epoch milliseconds at which the access token expires. */
  readonly expiresAt: number;
  /** Space-separated scope list returned by Bitbucket. */
  readonly scopes: string;
  /** Display info captured at login time so `whoami` works without a call. */
  readonly user: {
    readonly uuid: string;
    readonly displayName: string;
    readonly accountId: string | undefined;
  };
}

export interface TokenStore {
  load(): Promise<StoredToken | null>;
  save(token: StoredToken): Promise<void>;
  clear(): Promise<void>;
}
