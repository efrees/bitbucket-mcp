/**
 * `client_credentials` AuthProvider.
 *
 * Alternative to the 3LO AuthSession for operators who want a headless
 * flow: no browser, no loopback callback, no refresh token. Actions are
 * attributed to the OAuth consumer (not to a Bitbucket user), and the
 * returned token is workspace-scoped per Bitbucket's model.
 *
 * Token lifecycle:
 *   - No disk persistence. Tokens live in process memory only.
 *   - Fetched on first use via POST to the token endpoint with
 *     HTTP Basic (id:secret) and `grant_type=client_credentials`.
 *   - Re-fetched on demand when within REFRESH_SKEW_MS of expiry, or
 *     when the HTTP client forces a refresh after a 401.
 *   - No `refresh_token` is returned for this grant — by design,
 *     re-authentication is just a fresh POST.
 */

import { AuthError } from "../errors.js";
import { log } from "../logger.js";
import type { AuthProvider } from "../bitbucket/http-client.js";
import { basicAuth } from "./login-flow.js";
import { TOKEN_URL } from "./oauth-endpoints.js";

const REFRESH_SKEW_MS = 60_000;

interface CachedToken {
  readonly accessToken: string;
  readonly expiresAt: number;
}

interface TokenResponse {
  readonly access_token: string;
  readonly expires_in: number;
  readonly scopes?: string;
  readonly token_type?: string;
}

export interface ClientCredentialsAuthOptions {
  readonly clientId: string;
  readonly clientSecret: string;
}

export class ClientCredentialsAuth implements AuthProvider {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private cached: CachedToken | null = null;
  private inflight: Promise<string> | null = null;

  constructor(opts: ClientCredentialsAuthOptions) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
  }

  public async getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - Date.now() > REFRESH_SKEW_MS) {
      return this.cached.accessToken;
    }
    return this.fetchLocked();
  }

  public async refreshAccessToken(): Promise<string> {
    // No refresh_token in this grant — force a re-fetch by clearing the
    // cache. The HTTP client calls this after a 401 to cover tokens that
    // expired between read and use.
    this.cached = null;
    return this.fetchLocked();
  }

  /** Serialise concurrent fetches so the first caller wins the single token. */
  private async fetchLocked(): Promise<string> {
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchToken().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchToken(): Promise<string> {
    log.debug("auth(cc): requesting fresh client_credentials token");
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: basicAuth(this.clientId, this.clientSecret),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new AuthError(
        `client_credentials token request failed (${response.status}): ${detail.slice(0, 300)}`,
      );
    }
    const tr = (await response.json()) as TokenResponse;
    const token: CachedToken = {
      accessToken: tr.access_token,
      expiresAt: Date.now() + tr.expires_in * 1000,
    };
    this.cached = token;
    return token.accessToken;
  }
}
