import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as createComment from "../src/tools/create-pr-comment.ts";
import * as createInline from "../src/tools/create-pr-inline-comment.ts";
import * as reply from "../src/tools/reply-to-pr-comment.ts";
import type { ToolContext } from "../src/tools/index.ts";
import { captureHandler, makeContext, parseResult, storedComment, stubHttp } from "./tool-harness.ts";

interface CommentTool {
  readonly name: string;
  readonly register: (server: McpServer, ctx: ToolContext) => void;
  readonly args: Record<string, unknown>;
}

const TOOLS: CommentTool[] = [
  { name: "create_pr_comment", register: createComment.register, args: {} },
  {
    name: "create_pr_inline_comment",
    register: createInline.register,
    args: { path: "src/a.ts", side: "new", line: 3 },
  },
  { name: "reply_to_pr_comment", register: reply.register, args: { parent_comment_id: 55 } },
];

const base = { repo_slug: "repo", pull_request_id: 7, body: "hello" };

for (const tool of TOOLS) {
  test(`${tool.name}: omitting pending leaves the POST body without the field`, async () => {
    const http = stubHttp(storedComment({ pending: false }));
    const handler = captureHandler(tool.register, makeContext(http.client));

    const payload = parseResult(await handler({ ...base, ...tool.args }));

    const body = http.requests[0]?.options.jsonBody as Record<string, unknown>;
    assert.equal("pending" in body, false);
    assert.equal(payload["pending"], false);
  });

  test(`${tool.name}: pending:false also sends no pending field`, async () => {
    const http = stubHttp(storedComment({ pending: false }));
    const handler = captureHandler(tool.register, makeContext(http.client));

    await handler({ ...base, ...tool.args, pending: false });

    const body = http.requests[0]?.options.jsonBody as Record<string, unknown>;
    assert.equal("pending" in body, false);
  });

  test(`${tool.name}: pending:true is sent and the stored value is echoed`, async () => {
    const http = stubHttp(storedComment({ pending: true }));
    const handler = captureHandler(tool.register, makeContext(http.client));

    const payload = parseResult(await handler({ ...base, ...tool.args, pending: true }));

    const body = http.requests[0]?.options.jsonBody as Record<string, unknown>;
    assert.equal(body["pending"], true);
    assert.equal(payload["pending"], true);
  });

  test(`${tool.name}: echoes what Bitbucket stored, not what was requested`, async () => {
    // Bitbucket ignoring the flag must not be reported as a draft.
    const http = stubHttp(storedComment()); // `pending` absent from response
    const handler = captureHandler(tool.register, makeContext(http.client));

    const payload = parseResult(await handler({ ...base, ...tool.args, pending: true }));

    assert.equal(payload["pending"], false);
  });

  test(`${tool.name}: pending:true is refused under client_credentials with no request`, async () => {
    const http = stubHttp(storedComment({ pending: true }));
    const ctx = makeContext(http.client, { authMode: "client_credentials" });
    const handler = captureHandler(tool.register, ctx);

    const result = await handler({ ...base, ...tool.args, pending: true });

    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /authorization_code/);
    assert.equal(http.requests.length, 0);
  });

  test(`${tool.name}: client_credentials still posts when pending is not requested`, async () => {
    const http = stubHttp(storedComment({ pending: false }));
    const ctx = makeContext(http.client, { authMode: "client_credentials" });
    const handler = captureHandler(tool.register, ctx);

    const payload = parseResult(await handler({ ...base, ...tool.args }));

    assert.equal(http.requests.length, 1);
    assert.equal(payload["pending"], false);
  });
}
