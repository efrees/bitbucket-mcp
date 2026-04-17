/**
 * Bitbucket Cloud HTTP client.
 *
 * Thin wrapper around `fetch` that:
 *   - attaches the Bearer token from the auth session,
 *   - parses the Bitbucket error envelope into `BitbucketApiError`,
 *   - surfaces rate-limit information,
 *   - refreshes the access token on 401 (when a refresher is provided).
 *
 * The refresher is injected rather than imported directly to avoid a
 * cycle between this module and `src/auth/session.ts`.
 */

import { BitbucketApiError } from "../errors.js";
import { log } from "../logger.js";

export const BITBUCKET_API_BASE = "https://api.bitbucket.org/2.0";

export interface AuthProvider {
  /** Returns a currently-valid access token, refreshing if needed. */
  getAccessToken(): Promise<string>;
  /**
   * Invoked when the server returns 401 with a currently-held token, giving
   * the provider a chance to force a refresh. Must return the new access
   * token or throw.
   */
  refreshAccessToken(): Promise<string>;
}

export interface RequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "DELETE";
  readonly query?: Record<string, string | number | undefined | string[]>;
  readonly jsonBody?: unknown;
  readonly accept?: string;
  /** Full URL override (used for paginated `next` links). */
  readonly url?: string;
}

export class BitbucketHttpClient {
  private readonly baseUrl: string;
  private readonly auth: AuthProvider;

  constructor(auth: AuthProvider, baseUrl: string = BITBUCKET_API_BASE) {
    this.auth = auth;
    this.baseUrl = baseUrl;
  }

  public async requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.request(path, { ...options, accept: options.accept ?? "application/json" });
    if (response.status === 204) return undefined as unknown as T;
    return (await response.json()) as T;
  }

  public async requestText(path: string, options: RequestOptions = {}): Promise<string> {
    const response = await this.request(path, { ...options, accept: options.accept ?? "text/plain" });
    return await response.text();
  }

  /** Low-level request — usually callers want requestJson/requestText. */
  public async request(path: string, options: RequestOptions = {}): Promise<Response> {
    const url = options.url ?? this.buildUrl(path, options.query);
    const token = await this.auth.getAccessToken();
    let response = await this.send(url, options, token);

    if (response.status === 401) {
      // One retry after a forced refresh — covers tokens that expired mid-call.
      log.debug("bitbucket: got 401, attempting refresh-and-retry", { url });
      const fresh = await this.auth.refreshAccessToken();
      response = await this.send(url, options, fresh);
    }

    if (!response.ok) {
      throw await this.toApiError(response, url);
    }
    return response;
  }

  private async send(url: string, options: RequestOptions, token: string): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: options.accept ?? "application/json",
    };
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers,
    };
    if (options.jsonBody !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.jsonBody);
    }
    return fetch(url, init);
  }

  private buildUrl(path: string, query: RequestOptions["query"]): string {
    const normalized = path.startsWith("http") ? path : `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    if (!query) return normalized;
    const url = new URL(normalized);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, v);
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async toApiError(response: Response, url: string): Promise<BitbucketApiError> {
    const requestId = response.headers.get("X-Request-Id") ?? undefined;
    let message = `Bitbucket API error ${response.status}`;
    let code: string | undefined;
    let detail: string | undefined;

    const body = await response.text().catch(() => "");
    if (body) {
      try {
        const parsed = JSON.parse(body) as {
          error?: { message?: string; detail?: string; code?: string };
        };
        if (parsed.error) {
          if (typeof parsed.error.message === "string") message = parsed.error.message;
          if (typeof parsed.error.detail === "string") detail = parsed.error.detail;
          if (typeof parsed.error.code === "string") code = parsed.error.code;
        } else {
          detail = body.slice(0, 500);
        }
      } catch {
        // non-JSON body (e.g. plain text from /diff on error)
        detail = body.slice(0, 500);
      }
    }

    return new BitbucketApiError({
      status: response.status,
      url,
      message,
      ...(code !== undefined ? { code } : {}),
      ...(detail !== undefined ? { detail } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }
}
