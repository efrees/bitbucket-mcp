/**
 * Tool: `bitbucket_create_pr_comment`
 *
 * Posts a top-level (non-anchored, non-reply) comment on a PR. This is
 * the right tool for agents leaving a summary at the end of a review —
 * "Looks good overall; a few nits inline."
 *
 * For line-anchored review comments use `bitbucket_create_pr_inline_comment`.
 * For replying to an existing thread use `bitbucket_reply_to_pr_comment`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PullRequestComment } from "../bitbucket/types.js";
import {
  encodePathSegment,
  errorResult,
  jsonResult,
  requireWritesAllowed,
  resolveWorkspace,
} from "./helpers.js";
import type { ToolContext } from "./index.js";

export const inputSchema = {
  workspace: z
    .string()
    .optional()
    .describe("Workspace slug. Defaults to BITBUCKET_MCP_WORKSPACE if set."),
  repo_slug: z.string().describe("Repository slug (e.g. 'my-service')."),
  pull_request_id: z.number().int().positive().describe("PR number."),
  body: z
    .string()
    .min(1)
    .describe("Comment body (raw Markdown). Required — Bitbucket rejects empty comments."),
};

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "bitbucket_create_pr_comment",
    {
      title: "Create PR comment",
      description:
        "Post a new top-level comment on a PR. For replies, use bitbucket_reply_to_pr_comment; for line-anchored, bitbucket_create_pr_inline_comment.",
      inputSchema,
    },
    async (args) => {
      try {
        requireWritesAllowed(ctx);
        const workspace = resolveWorkspace(ctx, args.workspace);
        const path = `/repositories/${encodePathSegment(workspace)}/${encodePathSegment(args.repo_slug)}/pullrequests/${args.pull_request_id}/comments`;

        const comment = await ctx.http.requestJson<PullRequestComment>(path, {
          method: "POST",
          jsonBody: { content: { raw: args.body } },
        });

        return jsonResult({
          id: comment.id,
          author: comment.user.display_name,
          created_on: comment.created_on,
          url: comment.links?.html?.href,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
