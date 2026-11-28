import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "../src/tools/create-pr-inline-comment.ts";
import { captureHandler, makeContext, parseResult, storedComment, stubHttp } from "./tool-harness.ts";

const base = { repo_slug: "repo", pull_request_id: 7, body: "hi", path: "src/a.ts" };

function inlineBody(http: ReturnType<typeof stubHttp>): Record<string, unknown> {
  const body = http.requests[0]?.options.jsonBody as { inline: Record<string, unknown> };
  return body.inline;
}

test("inline comment: single line sends no start field and echoes start_line null", async () => {
  const http = stubHttp(storedComment({ inline: { path: "src/a.ts", to: 23 } }));
  const handler = captureHandler(register, makeContext(http.client));

  const payload = parseResult(await handler({ ...base, side: "new", line: 23 }));

  assert.deepEqual(inlineBody(http), { path: "src/a.ts", to: 23 });
  assert.equal(payload["start_line"], null);
});

test("inline comment: new-side range maps start_line to start_to", async () => {
  const http = stubHttp(storedComment({ inline: { path: "src/a.ts", to: 23, start_to: 20 } }));
  const handler = captureHandler(register, makeContext(http.client));

  const payload = parseResult(await handler({ ...base, side: "new", line: 23, start_line: 20 }));

  assert.deepEqual(inlineBody(http), { path: "src/a.ts", to: 23, start_to: 20 });
  assert.equal(payload["start_line"], 20);
  assert.equal(payload["line"], 23);
});

test("inline comment: old-side range maps start_line to start_from", async () => {
  const http = stubHttp(
    storedComment({ inline: { path: "src/a.ts", from: 29, start_from: 26 } }),
  );
  const handler = captureHandler(register, makeContext(http.client));

  const payload = parseResult(await handler({ ...base, side: "old", line: 29, start_line: 26 }));

  assert.deepEqual(inlineBody(http), { path: "src/a.ts", from: 29, start_from: 26 });
  assert.equal(payload["start_line"], 26);
});

test("inline comment: start_line equal to line is allowed", async () => {
  const http = stubHttp(storedComment({ inline: { path: "src/a.ts", to: 5, start_to: 5 } }));
  const handler = captureHandler(register, makeContext(http.client));

  const result = await handler({ ...base, side: "new", line: 5, start_line: 5 });

  assert.equal(result.isError, undefined);
  assert.deepEqual(inlineBody(http), { path: "src/a.ts", to: 5, start_to: 5 });
});

test("inline comment: start_line after line is refused before any request", async () => {
  const http = stubHttp(storedComment());
  const handler = captureHandler(register, makeContext(http.client));

  const result = await handler({ ...base, side: "new", line: 20, start_line: 23 });

  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /start_line \(23\) must be less than or equal to line \(20\)/);
  assert.equal(http.requests.length, 0);
});

test("inline comment: echoes the stored start, not the requested one", async () => {
  // If Bitbucket dropped the range, the agent must see a single-line comment.
  const http = stubHttp(storedComment({ inline: { path: "src/a.ts", to: 23 } }));
  const handler = captureHandler(register, makeContext(http.client));

  const payload = parseResult(await handler({ ...base, side: "new", line: 23, start_line: 20 }));

  assert.equal(payload["start_line"], null);
});
