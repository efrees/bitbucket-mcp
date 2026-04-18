/**
 * Auth session — in-memory cache on top of TokenStore plus token refresh.
 *
 * Implements the AuthProvider interface that BitbucketHttpClient depends
 * on. Centralises the refresh logic so callers don't have to think about
 * expiry — just call `getAccessToken()` and get back a valid token (or a
 * clear AuthError if the user needs to re-login).
 *
 * Refresh behavior:
 *   - Access tokens live 2 hours (per Bitbucket).
 *   - We refresh proactively if the stored token is within
 *     REFRESH_SKEW_MS of expiring (default: 60s).
 *   - The HTTP client also force-refreshes on a 401 for tokens that
 *     expired between cache read and request landing.
 *   - Refresh tokens rotate on every refresh — we always persist the
 *     new refresh token from the response.
 */

import { AuthError } from "../errors.js";
import { log } from "../logger.js";
import type { AuthProvider } from "../bitbucket/http-client.js";
import { basicAuth } from "./login-flow.js";
import { TOKEN_URL } from "./oauth-endpoints.js";
import type { StoredToken, TokenStore } from "./token-store.js";

/** Refresh if the cached access token is within this many ms of expiry. */
const REFRESH_SKEW_MS = 60_000;

export interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
  readonly scopes: string;
  readonly token_type: string;
}

export interface AuthSessionOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tokenStore: TokenStore;
}

export class AuthSession implements AuthProvider {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly tokenStore: TokenStore;
  private cached: StoredToken | null = null;
  private inflightRefresh: Promise<StoredToken> | null = null;

  constructor(opts: AuthSessionOptions) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.tokenStore = opts.tokenStore;
  }

  public async getAccessToken(): Promise<string> {
    const token = await this.loadCurrent();
    if (token.expiresAt - Date.now() > REFRESH_SKEW_MS) {
      return token.accessToken;
    }
    log.debug("auth: access token near expiry, refreshing");
    const refreshed = await this.refreshLocked(token.refreshToken);
    return refreshed.accessToken;
  }

  public async refreshAccessToken(): Promise<string> {
    const token = await this.loadCurrent();
    const refreshed = await this.refreshLocked(token.refreshToken);
    return refreshed.accessToken;
  }

  public async whoami(): Promise<StoredToken["user"]> {
    const token = await this.loadCurrent();
    return token.user;
  }

  /** Replace the cached/stored token outright (used by the login command). */
  public async setToken(token: StoredToken): Promise<void> {
    this.cached = token;
    await this.tokenStore.save(token);
  }

  public async clear(): Promise<void> {
    this.cached = null;
    await this.tokenStore.clear();
  }

  private async loadCurrent(): Promise<StoredToken> {
    if (this.cached) return this.cached;
    const loaded = await this.tokenStore.load();
    if (!loaded) {
      throw new AuthError(
        `No stored Bitbucket credentials. Run \`bitbucket-mcp login\` first.`,
      );
    }
    this.cached = loaded;
    return loaded;
  }

  /** Serialize refresh calls so concurrent callers share one network op. */
  private async refreshLocked(refreshToken: string): Promise<StoredToken> {
    if (this.inflightRefresh) return this.inflightRefresh;
    this.inflightRefresh = this.doRefresh(refreshToken).finally(() => {
      this.inflightRefresh = null;
    });
    return this.inflightRefresh;
  }

  private async doRefresh(refreshToken: string): Promise<StoredToken> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        // Bitbucket requires HTTP Basic auth at the token endpoint for
        // refresh as well as initial exchange.
        Authorization: basicAuth(this.clientId, this.clientSecret),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new AuthError(
        `Refresh failed (${response.status}): ${detail.slice(0, 300)}. ` +
          `If this keeps happening, run \`bitbucket-mcp login\` to reauthenticate.`,
      );
    }
    const tr = (await response.json()) as TokenResponse;

    const existing = this.cached;
    if (!existing) {
      throw new AuthError("Refresh succeeded but no cached token metadata was available.");
    }
    const refreshed: StoredToken = {
      accessToken: tr.access_token,
      refreshToken: tr.refresh_token,
      expiresAt: Date.now() + tr.expires_in * 1000,
      scopes: tr.scopes,
      user: existing.user,
    };
    this.cached = refreshed;
    await this.tokenStore.save(refreshed);
    return refreshed;
  }
}
