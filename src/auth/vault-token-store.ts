/**
 * TokenStore implemented as JSON serialization over a SecretVault.
 *
 * The vault handles encryption-at-rest per platform; this layer only
 * owns the (de)serialization of the StoredToken shape and the "missing
 * vs corrupt" distinction.
 */

import { AuthError } from "../errors.js";
import type { SecretVault } from "./secret-vault.js";
import type { StoredToken, TokenStore } from "./token-store.js";

/** Vault key for the persisted 3LO tokens (file backends map it to tokens.bin). */
export const TOKENS_VAULT_KEY = "tokens";

export class VaultTokenStore implements TokenStore {
  private readonly vault: SecretVault;

  constructor(vault: SecretVault) {
    this.vault = vault;
  }

  public async load(): Promise<StoredToken | null> {
    const raw = await this.vault.get(TOKENS_VAULT_KEY);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as StoredToken;
    } catch (err) {
      throw new AuthError(
        `Stored token decrypted (${this.vault.backendName}) but could not be parsed: ` +
          `${(err as Error).message}. Run \`bitbucket-mcp logout\` then \`bitbucket-mcp login\`.`,
      );
    }
  }

  public async save(token: StoredToken): Promise<void> {
    await this.vault.set(TOKENS_VAULT_KEY, JSON.stringify(token));
  }

  public async clear(): Promise<void> {
    await this.vault.delete(TOKENS_VAULT_KEY);
  }
}
