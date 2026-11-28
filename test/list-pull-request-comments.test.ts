import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "../src/tools/list-pull-request-comments.ts";
import { captureHandler, makeContext, parseResult, storedComment, stubHttp } from "./tool-harness.ts";

test("list comments: keeps the start line of a multi-line inline range", async () => {
  const http = stubHttp({
    pagelen: 50,
    values: [
      storedComment({ id: 1, inline: { path: "a.ts", to: 23, start_to: 20 } }),
      storedComment({ id: 2, inline: { path: "a.ts", from: 9 } }),
    ],
  });
  const handler = captureHandler(register, makeContext(http.client));

  const payload = parseResult(await handler({ repo_slug: "repo", pull_request_id: 7 }));
  const comments = payload["comments"] as { inline: Record<string, unknown> }[];

  assert.deepEqual(comments[0]?.inline, {
    path: "a.ts",
    to: 23,
    from: null,
    start_to: 20,
    start_from: null,
  });
  assert.deepEqual(comments[1]?.inline, {
    path: "a.ts",
    to: null,
    from: 9,
    start_to: null,
    start_from: null,
  });
});

test("list comments: reports each comment's pending (draft) state", async () => {
  const http = stubHttp({
    pagelen: 50,
    values: [
      storedComment({ id: 1, pending: false }),
      storedComment({ id: 2, pending: true }),
      storedComment({ id: 3 }), // field absent: treated as published
    ],
  });
  const handler = captureHandler(register, makeContext(http.client));

  const payload = parseResult(await handler({ repo_slug: "repo", pull_request_id: 7 }));
  const comments = payload["comments"] as { id: number; pending: boolean }[];

  assert.deepEqual(
    comments.map((c) => [c.id, c.pending]),
    [
      [1, false],
      [2, true],
      [3, false],
    ],
  );
});
