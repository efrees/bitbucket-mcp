/**
 * Bitbucket Cloud HTTP client.
 *
 * Thin wrapper around `fetch` that:
 *   - attaches the Bearer token from the auth session,
 *   - parses the Bitbucket error envelope into `BitbucketApiError`,
 *   - honors 429 Retry-After and retries transient 5xx with backoff,
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

export interface RetryPolicy {
  /** Max retries for retriable statuses (429 / 5xx). Defaults to 3. */
  readonly maxRetries?: number;
  /** Initial backoff in ms when no Retry-After is supplied. Defaults to 500. */
  readonly baseBackoffMs?: number;
  /** Cap on any single backoff interval. Defaults to 20_000. */
  readonly maxBackoffMs?: number;
  /** Test hook for deterministic tests — defaults to setTimeout-based sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS: Required<Omit<RetryPolicy, "sleep">> = {
  maxRetries: 3,
  baseBackoffMs: 500,
  maxBackoffMs: 20_000,
};

export class BitbucketHttpClient {
  private readonly baseUrl: string;
  private readonly auth: AuthProvider;
  private readonly retry: Required<RetryPolicy>;

  constructor(auth: AuthProvider, baseUrl: string = BITBUCKET_API_BASE, retry: RetryPolicy = {}) {
    this.auth = auth;
    this.baseUrl = baseUrl;
    this.retry = {
      maxRetries: retry.maxRetries ?? DEFAULTS.maxRetries,
      baseBackoffMs: retry.baseBackoffMs ?? DEFAULTS.baseBackoffMs,
      maxBackoffMs: retry.maxBackoffMs ?? DEFAULTS.maxBackoffMs,
      sleep: retry.sleep ?? defaultSleep,
    };
  }

  public async requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.request(path, {
      ...options,
      accept: options.accept ?? "application/json",
    });
    if (response.status === 204) return undefined as unknown as T;
    return (await response.json()) as T;
  }

  public async requestText(path: string, options: RequestOptions = {}): Promise<string> {
    const response = await this.request(path, {
      ...options,
      accept: options.accept ?? "text/plain",
    });
    return await response.text();
  }

  /** Low-level request — usually callers want requestJson/requestText. */
  public async request(path: string, options: RequestOptions = {}): Promise<Response> {
    const url = options.url ?? this.buildUrl(path, options.query);
    let token = await this.auth.getAccessToken();
    let response = await this.send(url, options, token);

    if (response.status === 401) {
      log.debug("bitbucket: got 401, attempting refresh-and-retry", { url });
      token = await this.auth.refreshAccessToken();
      response = await this.send(url, options, token);
    }

    // 429 / 5xx retry loop with capped exponential backoff.
    let attempt = 0;
    while (isRetriable(response.status) && attempt < this.retry.maxRetries) {
      const waitMs = this.computeBackoff(response, attempt);
      log.warn("bitbucket: retriable error, backing off", {
        url,
        status: response.status,
        attempt: attempt + 1,
        wait_ms: waitMs,
      });
      await this.retry.sleep(waitMs);
      await discardBody(response);
      response = await this.send(url, options, token);
      attempt += 1;
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
    const normalized = path.startsWith("http")
      ? path
      : `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
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

  private computeBackoff(response: Response, attempt: number): number {
    const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
    if (retryAfter !== null) return Math.min(retryAfter, this.retry.maxBackoffMs);
    // Exponential: base * 2^attempt, capped at maxBackoffMs, plus a tiny jitter.
    const exp = this.retry.baseBackoffMs * 2 ** attempt;
    const jitter = Math.floor(Math.random() * 100);
    return Math.min(exp + jitter, this.retry.maxBackoffMs);
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

function isRetriable(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Parse an RFC 7231 Retry-After header. Returns milliseconds, or null if
 * the header is missing or unparseable. Supports both delta-seconds
 * ("120") and HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT") forms.
 */
export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
  const when = Date.parse(header);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - Date.now());
}

async function discardBody(response: Response): Promise<void> {
  // Some fetch implementations don't release the body slot until consumed.
  try {
    await response.arrayBuffer();
  } catch {
    // ignore
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
