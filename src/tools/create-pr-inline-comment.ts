/**
 * Tool: `bitbucket_create_pr_inline_comment`
 *
 * Posts a line-anchored review comment. The agent supplies `side` and
 * `line` as ergonomic inputs; internally we translate to Bitbucket's
 * `inline.to` (new side) or `inline.from` (old side).
 *
 * API constraint (see docs/bitbucket-api.md §4): exactly one of
 * `inline.to` or `inline.from` is allowed per comment. Our schema
 * enforces this by accepting `side` as an enum + a single `line`
 * number, eliminating the "both or neither" failure mode.
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

const SIDE = z.enum(["new", "old"]);

export const inputSchema = {
  workspace: z
    .string()
    .optional()
    .describe("Workspace slug. Defaults to BITBUCKET_MCP_WORKSPACE if set."),
  repo_slug: z.string().describe("Repository slug (e.g. 'my-service')."),
  pull_request_id: z.number().int().positive().describe("PR number."),
  path: z
    .string()
    .min(1)
    .describe(
      "File path as it appears in the diff. For renamed files use the new path (post-rename).",
    ),
  side: SIDE.describe(
    "Which side of the diff to anchor on. 'new' for lines in the proposed version (most common), 'old' for commenting on removed lines.",
  ),
  line: z.number().int().positive().describe("Line number on the chosen side."),
  body: z.string().min(1).describe("Comment body (raw Markdown)."),
};

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "bitbucket_create_pr_inline_comment",
    {
      title: "Create inline PR comment",
      description:
        "Post a line-anchored review comment. Specify `side` ('new' | 'old') and `line`; exactly one anchor is attached.",
      inputSchema,
    },
    async (args) => {
      try {
        requireWritesAllowed(ctx);
        const workspace = resolveWorkspace(ctx, args.workspace);
        const path = `/repositories/${encodePathSegment(workspace)}/${encodePathSegment(args.repo_slug)}/pullrequests/${args.pull_request_id}/comments`;

        const inline: { path: string; to?: number; from?: number } = { path: args.path };
        if (args.side === "new") inline.to = args.line;
        else inline.from = args.line;

        const comment = await ctx.http.requestJson<PullRequestComment>(path, {
          method: "POST",
          jsonBody: {
            content: { raw: args.body },
            inline,
          },
        });

        return jsonResult({
          id: comment.id,
          path: comment.inline?.path ?? args.path,
          side: args.side,
          line: args.line,
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
