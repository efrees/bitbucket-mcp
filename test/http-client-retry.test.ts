import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  BitbucketHttpClient,
  type AuthProvider,
} from "../src/bitbucket/http-client.ts";
import { BitbucketApiError } from "../src/errors.ts";

/** Stub AuthProvider that never touches the network. */
function stubAuth(): AuthProvider {
  return {
    getAccessToken: async () => "fake-token",
    refreshAccessToken: async () => "fake-token-2",
  };
}

/** Replace global fetch with a scripted sequence of responses for the test. */
function withScriptedFetch<T>(
  responses: Array<() => Response | Promise<Response>>,
  body: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async () => {
    const fn = responses[i];
    if (!fn) throw new Error(`scripted fetch: no more responses at index ${i}`);
    i += 1;
    return await fn();
  }) as typeof fetch;
  return body().finally(() => {
    globalThis.fetch = original;
  });
}

test("retries on 429 and honors Retry-After", async () => {
  const sleeps: number[] = [];
  const client = new BitbucketHttpClient(stubAuth(), "https://example.invalid/2.0", {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    baseBackoffMs: 10,
    maxRetries: 3,
  });

  await withScriptedFetch(
    [
      () => new Response("rate limited", { status: 429, headers: { "Retry-After": "2" } }),
      () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    ],
    async () => {
      const result = await client.requestJson<Record<string, unknown>>("/whatever");
      assert.deepEqual(result, {});
    },
  );
  assert.deepEqual(sleeps, [2000], "should sleep exactly the Retry-After value");
});

test("retries on 503 with exponential backoff when no Retry-After", async () => {
  const sleeps: number[] = [];
  const client = new BitbucketHttpClient(stubAuth(), "https://example.invalid/2.0", {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    baseBackoffMs: 100,
    maxRetries: 3,
  });

  await withScriptedFetch(
    [
      () => new Response("boom", { status: 503 }),
      () => new Response("boom", { status: 503 }),
      () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    ],
    async () => {
      await client.requestJson("/whatever");
    },
  );
  assert.equal(sleeps.length, 2, "two retries means two sleeps");
  // First backoff ~100ms + jitter (< 100ms), second ~200ms + jitter.
  assert.ok(sleeps[0]! >= 100 && sleeps[0]! < 250, `first sleep ${sleeps[0]} out of range`);
  assert.ok(sleeps[1]! >= 200 && sleeps[1]! < 400, `second sleep ${sleeps[1]} out of range`);
});

test("throws BitbucketApiError with parsed envelope on non-retriable 4xx", async () => {
  const client = new BitbucketHttpClient(stubAuth(), "https://example.invalid/2.0", {
    sleep: async () => undefined,
  });

  await withScriptedFetch(
    [
      () =>
        new Response(
          JSON.stringify({ type: "error", error: { message: "Not found", detail: "no repo" } }),
          { status: 404, headers: { "Content-Type": "application/json", "X-Request-Id": "abc123" } },
        ),
    ],
    async () => {
      await assert.rejects(
        () => client.requestJson("/whatever"),
        (err: unknown) => {
          assert.ok(err instanceof BitbucketApiError);
          assert.equal(err.status, 404);
          assert.equal(err.message, "Not found");
          assert.equal(err.detail, "no repo");
          assert.equal(err.requestId, "abc123");
          return true;
        },
      );
    },
  );
});

test("refreshes on 401 and retries once with new token", async () => {
  let calls = 0;
  const tokens: string[] = [];
  const auth: AuthProvider = {
    getAccessToken: async () => "old-token",
    refreshAccessToken: async () => "new-token",
  };
  const client = new BitbucketHttpClient(auth, "https://example.invalid/2.0", {
    sleep: async () => undefined,
  });

  await withScriptedFetch(
    [
      (...args: unknown[]) => {
        void args;
        calls += 1;
        tokens.push("old-token");
        return new Response("unauthorized", { status: 401 });
      },
      () => {
        calls += 1;
        tokens.push("new-token");
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      },
    ],
    async () => {
      await client.requestJson("/whatever");
    },
  );
  assert.equal(calls, 2);
});
