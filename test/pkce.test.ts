import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { generatePkcePair, generateState } from "../src/auth/pkce.ts";

test("generatePkcePair returns a valid S256 verifier/challenge pair", () => {
  const pair = generatePkcePair();

  assert.equal(pair.method, "S256");
  assert.match(
    pair.verifier,
    /^[A-Za-z0-9_-]+$/,
    "verifier must be base64url (no +, /, or padding)",
  );
  assert.ok(
    pair.verifier.length >= 43 && pair.verifier.length <= 128,
    `verifier length ${pair.verifier.length} outside RFC range`,
  );

  // Challenge must be sha256(verifier) base64url-encoded, per RFC 7636.
  const expected = createHash("sha256")
    .update(pair.verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  assert.equal(pair.challenge, expected);
});

test("generatePkcePair produces fresh values on each call", () => {
  const a = generatePkcePair();
  const b = generatePkcePair();
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.challenge, b.challenge);
});

test("generateState returns url-safe tokens", () => {
  const state = generateState();
  assert.match(state, /^[A-Za-z0-9_-]+$/);
  assert.ok(state.length >= 16);
});
