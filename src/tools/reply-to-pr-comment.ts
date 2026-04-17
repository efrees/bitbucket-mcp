/**
 * Tool: `bitbucket_reply_to_pr_comment`
 *
 * Posts a reply to an existing comment. The reply is added as a child
 * of the specified parent comment, preserving the thread structure.
 * Parent comment ids come from `bitbucket_list_pull_request_comments`.
 *
 * This is the main write-path for "agent acting on reviewer feedback"
 * workflows — the reviewer left a comment, the agent fixed it, and
 * the agent replies to confirm with the commit hash or explanation.
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
  parent_comment_id: z
    .number()
    .int()
    .positive()
    .describe(
      "Id of the comment being replied to (from bitbucket_list_pull_request_comments).",
    ),
  body: z.string().min(1).describe("Reply body (raw Markdown). Required."),
};

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "bitbucket_reply_to_pr_comment",
    {
      title: "Reply to PR comment",
      description:
        "Reply to an existing PR comment, preserving thread structure. Use the parent comment's id from list_pull_request_comments.",
      inputSchema,
    },
    async (args) => {
      try {
        requireWritesAllowed(ctx);
        const workspace = resolveWorkspace(ctx, args.workspace);
        const path = `/repositories/${encodePathSegment(workspace)}/${encodePathSegment(args.repo_slug)}/pullrequests/${args.pull_request_id}/comments`;

        const comment = await ctx.http.requestJson<PullRequestComment>(path, {
          method: "POST",
          jsonBody: {
            content: { raw: args.body },
            parent: { id: args.parent_comment_id },
          },
        });

        return jsonResult({
          id: comment.id,
          parent_id: comment.parent?.id ?? args.parent_comment_id,
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
