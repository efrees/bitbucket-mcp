/**
 * Shared error types.
 *
 * `BitbucketApiError` carries HTTP status + Bitbucket's error envelope so
 * callers (and MCP tool handlers) can surface actionable messages without
 * parsing response bodies themselves.
 *
 * `ConfigError` is for anything wrong with local config or token state
 * (missing client_id, no login, corrupted token file). These are treated
 * distinctly because the remediation is user-side, not retry-side.
 */

export class BitbucketApiError extends Error {
  public readonly status: number;
  public readonly code: string | undefined;
  public readonly detail: string | undefined;
  public readonly requestId: string | undefined;
  public readonly url: string;

  constructor(args: {
    status: number;
    url: string;
    message: string;
    code?: string | undefined;
    detail?: string | undefined;
    requestId?: string | undefined;
  }) {
    super(args.message);
    this.name = "BitbucketApiError";
    this.status = args.status;
    this.url = args.url;
    this.code = args.code;
    this.detail = args.detail;
    this.requestId = args.requestId;
  }

  /** True for statuses that may succeed on retry (429 / 5xx). */
  public get retriable(): boolean {
    return this.status === 429 || (this.status >= 500 && this.status <= 599);
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}
