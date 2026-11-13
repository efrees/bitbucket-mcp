/**
 * Pure text helpers for feeding CI log output to an agent.
 *
 * Build logs are large, noisy, and occasionally leak credentials, so
 * before a log excerpt leaves this process we:
 *   - strip terminal escape sequences (colour codes are pure noise to a model),
 *   - redact strings that look like credentials,
 *   - keep only the tail, where a failing step's errors almost always are.
 *
 * Redaction is best-effort pattern matching, not a guarantee. Bitbucket
 * Pipelines already masks *secured* variables server-side; this is a
 * second net for secrets that reach the log some other way.
 */

export const REDACTED = "[REDACTED]";

// CSI sequences (colours, cursor movement) and OSC sequences (titles, hyperlinks).
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

/** Each entry keeps capture group 1 (the non-secret prefix) and redacts the rest. */
const PREFIXED_SECRET_PATTERNS: readonly RegExp[] = [
  // Authorization: Bearer xxx / Basic xxx
  /\b((?:Bearer|Basic)\s+)[A-Za-z0-9+/_.~=-]{8,}/g,
  // scheme://user:password@host
  /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(?=@)/gi,
  // password=xxx, API_KEY: xxx, "client_secret": "xxx"
  /((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\w*["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi,
];

const BARE_SECRET_PATTERNS: readonly RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bATATT[A-Za-z0-9_=-]{20,}/g, // Atlassian API tokens
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWTs
];

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export function redactSecrets(text: string): string {
  let out = text.replace(PRIVATE_KEY_PATTERN, REDACTED);
  for (const pattern of PREFIXED_SECRET_PATTERNS) {
    out = out.replace(pattern, `$1${REDACTED}`);
  }
  for (const pattern of BARE_SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

export function sanitizeLog(text: string): string {
  return redactSecrets(stripAnsi(text).replace(/\r\n?/g, "\n"));
}

/**
 * Keep the last `maxBytes` of `text`, starting on a line boundary so the
 * excerpt never opens mid-line (or mid-UTF-8-sequence).
 */
export function tailText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  return { text: dropPartialFirstLine(buf.subarray(buf.length - maxBytes).toString("utf8")), truncated: true };
}

/** For text that is known to begin at an arbitrary byte offset. */
export function dropPartialFirstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(newline + 1);
}
