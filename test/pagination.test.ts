import { strict as assert } from "node:assert";
import { test } from "node:test";
import { collectAll } from "../src/bitbucket/pagination.ts";
import type { BitbucketHttpClient } from "../src/bitbucket/http-client.ts";
import type { Paged } from "../src/bitbucket/types.ts";

/**
 * Stub HTTP client for testing pagination logic without a network.
 * Only the methods the helpers touch are implemented.
 */
function makeStubHttp(pages: Paged<number>[]): BitbucketHttpClient {
  let i = 0;
  return {
    async requestJson<T>(): Promise<T> {
      const page = pages[i];
      if (!page) throw new Error(`stub http: ran out of pages at index ${i}`);
      i += 1;
      return page as unknown as T;
    },
  } as unknown as BitbucketHttpClient;
}

test("collectAll flattens values across pages", async () => {
  const http = makeStubHttp([
    { pagelen: 2, values: [1, 2], next: "https://example/next-1" },
    { pagelen: 2, values: [3, 4], next: "https://example/next-2" },
    { pagelen: 2, values: [5] },
  ]);
  const result = await collectAll<number>(http, "/whatever");
  assert.deepEqual(result.values, [1, 2, 3, 4, 5]);
  assert.equal(result.pagesFetched, 3);
  assert.equal(result.truncated, false);
});

test("collectAll marks truncated=true when stopping early", async () => {
  const http = makeStubHttp([
    { pagelen: 2, values: [1, 2], next: "https://example/next-1" },
    { pagelen: 2, values: [3, 4], next: "https://example/next-2" },
    { pagelen: 2, values: [5, 6], next: "https://example/next-3" },
  ]);
  const result = await collectAll<number>(http, "/whatever", undefined, { maxPages: 2 });
  assert.deepEqual(result.values, [1, 2, 3, 4]);
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.truncated, true);
});

test("collectAll returns truncated=false on a single-page response", async () => {
  const http = makeStubHttp([{ pagelen: 2, values: [1, 2] }]);
  const result = await collectAll<number>(http, "/whatever");
  assert.deepEqual(result.values, [1, 2]);
  assert.equal(result.pagesFetched, 1);
  assert.equal(result.truncated, false);
});
