/**
 * PKCE (RFC 7636) helpers for the OAuth authorization-code flow.
 *
 * Kept tiny and dependency-free — the MCP SDK bundles `pkce-challenge`,
 * but we roll our own to avoid coupling our auth module to an SDK
 * internal and to keep the exact code paths auditable.
 */

import { createHash, randomBytes } from "node:crypto";

export interface PkcePair {
  /** High-entropy random string, 43–128 chars, URL-safe. */
  readonly verifier: string;
  /** SHA-256 of the verifier, base64url-encoded. */
  readonly challenge: string;
  /** Hash method — we always use S256. */
  readonly method: "S256";
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generate a fresh verifier + matching challenge.
 * Verifier length is 64 chars (48 random bytes → 64 base64url chars) which
 * sits comfortably inside the 43–128 RFC range.
 */
export function generatePkcePair(): PkcePair {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

/** Generate an opaque `state` value for CSRF protection on the callback. */
export function generateState(): string {
  return base64url(randomBytes(16));
}
