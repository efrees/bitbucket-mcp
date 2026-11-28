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
 *
 * An optional `start_line` turns the comment into a multi-line range
 * ending at `line`, mapped to `inline.start_to` / `inline.start_from`
 * on the same side. Bitbucket rejects a range whose start comes after its
 * end or whose start and end are on different sides; the single `side`
 * input makes the latter unrepresentable, and we check the former before
 * sending.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PullRequestComment } from "../bitbucket/types.js";
import {
  encodePathSegment,
  errorResult,
  jsonResult,
  pendingCommentFields,
  pendingInput,
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
  line: z
    .number()
    .int()
    .positive()
    .describe("Line number on the chosen side. For a multi-line comment, the last line of the range."),
  start_line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "First line of a multi-line range on the same side, ending at `line` (must be <= `line`). Omit for a single-line comment.",
    ),
  body: z.string().min(1).describe("Comment body (raw Markdown)."),
  pending: pendingInput,
};

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "bitbucket_create_pr_inline_comment",
    {
      title: "Create inline PR comment",
      description:
        "Post a line-anchored review comment. Specify `side` ('new' | 'old') and `line`; exactly one anchor is attached. Add `start_line` to comment on the range start_line..line. Pass pending:true to leave it as a draft only you can see until you publish your review in the web UI (authorization_code mode only).",
      inputSchema,
    },
    async (args) => {
      try {
        requireWritesAllowed(ctx);
        const workspace = resolveWorkspace(ctx, args.workspace);
        const pending = pendingCommentFields(ctx, args.pending);
        if (args.start_line !== undefined && args.start_line > args.line) {
          throw new Error(
            `start_line (${args.start_line}) must be less than or equal to line (${args.line}).`,
          );
        }
        const path = `/repositories/${encodePathSegment(workspace)}/${encodePathSegment(args.repo_slug)}/pullrequests/${args.pull_request_id}/comments`;

        const inline: {
          path: string;
          to?: number;
          from?: number;
          start_to?: number;
          start_from?: number;
        } = { path: args.path };
        if (args.side === "new") {
          inline.to = args.line;
          if (args.start_line !== undefined) inline.start_to = args.start_line;
        } else {
          inline.from = args.line;
          if (args.start_line !== undefined) inline.start_from = args.start_line;
        }

        const comment = await ctx.http.requestJson<PullRequestComment>(path, {
          method: "POST",
          jsonBody: {
            content: { raw: args.body },
            inline,
            ...pending,
          },
        });

        return jsonResult({
          id: comment.id,
          path: comment.inline?.path ?? args.path,
          side: args.side,
          line: args.line,
          // The range start Bitbucket stored (null for a single-line
          // comment), so a dropped start_line doesn't go unnoticed.
          start_line:
            (args.side === "new" ? comment.inline?.start_to : comment.inline?.start_from) ?? null,
          // Echo what Bitbucket stored, not what we requested, so the agent
          // can confirm whether the comment really is a hidden draft.
          pending: comment.pending ?? false,
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
