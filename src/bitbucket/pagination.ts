/**
 * Pagination helpers for Bitbucket's `next`-URL envelopes.
 *
 * Bitbucket does cursor-style pagination: each page returns a `next` URL
 * to fetch verbatim. Rebuilding the URL yourself is brittle (filters,
 * q= ordering, etc. shift subtly), so we walk `next` as-is.
 *
 * `collectAll` enforces a hard page cap to keep an agent from accidentally
 * paging through thousands of records on a huge repo. Callers that expect
 * large results should page manually via `paginate`.
 */

import type { BitbucketHttpClient } from "./http-client.js";
import type { Paged } from "./types.js";

/** Default pagelen — the max across most endpoints is 100, we use 50 as a safer default. */
export const DEFAULT_PAGELEN = 50;
/** Default cap when auto-collecting — ~500 items at pagelen 50. */
export const DEFAULT_MAX_PAGES = 10;

export interface PaginateOptions {
  readonly maxPages?: number;
}

/**
 * Yield pages one at a time. Stops at `maxPages` (default 10) or when
 * `next` is absent.
 */
export async function* paginate<T>(
  http: BitbucketHttpClient,
  firstPath: string,
  firstQuery?: Record<string, string | number | undefined | string[]>,
  options: PaginateOptions = {},
): AsyncGenerator<Paged<T>> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  let page = firstQuery
    ? await http.requestJson<Paged<T>>(firstPath, { query: firstQuery })
    : await http.requestJson<Paged<T>>(firstPath);
  let count = 1;
  yield page;
  while (page.next && count < maxPages) {
    page = await http.requestJson<Paged<T>>("", { url: page.next });
    count += 1;
    yield page;
  }
}

/** Convenience: flatten paginate() into a single array. */
export async function collectAll<T>(
  http: BitbucketHttpClient,
  firstPath: string,
  firstQuery?: Record<string, string | number | undefined | string[]>,
  options: PaginateOptions = {},
): Promise<{ readonly values: T[]; readonly truncated: boolean; readonly pagesFetched: number }> {
  const values: T[] = [];
  let pagesFetched = 0;
  let truncated = false;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  for await (const page of paginate<T>(http, firstPath, firstQuery, options)) {
    values.push(...page.values);
    pagesFetched += 1;
    if (pagesFetched >= maxPages && page.next) {
      truncated = true;
      break;
    }
  }
  return { values, truncated, pagesFetched };
}
