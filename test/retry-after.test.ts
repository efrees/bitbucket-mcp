import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseRetryAfter } from "../src/bitbucket/http-client.ts";

test("parseRetryAfter returns null for missing header", () => {
  assert.equal(parseRetryAfter(null), null);
});

test("parseRetryAfter accepts delta-seconds", () => {
  assert.equal(parseRetryAfter("30"), 30_000);
  assert.equal(parseRetryAfter("0"), 0);
});

test("parseRetryAfter accepts HTTP-date and returns positive ms-in-future", () => {
  const future = new Date(Date.now() + 60_000).toUTCString();
  const ms = parseRetryAfter(future);
  assert.ok(ms !== null && ms > 55_000 && ms < 65_000, `expected ~60s, got ${ms}`);
});

test("parseRetryAfter returns 0 for an HTTP-date in the past", () => {
  const past = new Date(Date.now() - 60_000).toUTCString();
  assert.equal(parseRetryAfter(past), 0);
});

test("parseRetryAfter returns null for garbage", () => {
  assert.equal(parseRetryAfter("not a date"), null);
});
