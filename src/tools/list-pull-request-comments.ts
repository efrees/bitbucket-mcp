/**
 * Tool: `bitbucket_list_pull_request_comments`
 *
 * Lists all comments on a PR — top-level, replies, and inline (line-
 * anchored) review comments — in a single flat array. Each comment
 * carries the minimum fields an agent needs to decide what to respond
 * to: content, author, inline anchor, parent id, and deleted state.
 *
 * Threading is reconstructable client-side via `parent_id`. We do not
 * pre-build a tree because agents doing review work often want to see
 * the flat chronological list anyway.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { collectAll, DEFAULT_PAGELEN } from "../bitbucket/pagination.js";
import type { PullRequestComment } from "../bitbucket/types.js";
import { encodePathSegment, errorResult, jsonResult, resolveWorkspace } from "./helpers.js";
import type { ToolContext } from "./index.js";

export const inputSchema = {
  workspace: z
    .string()
    .optional()
    .describe("Workspace slug. Defaults to BITBUCKET_MCP_WORKSPACE if set."),
  repo_slug: z.string().describe("Repository slug (e.g. 'my-service')."),
  pull_request_id: z.number().int().positive().describe("PR number."),
  include_deleted: z
    .boolean()
    .optional()
    .describe("Include soft-deleted comments in the result. Default: false."),
  max_pages: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Maximum pages to fetch (default: 5)."),
};

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "bitbucket_list_pull_request_comments",
    {
      title: "List PR comments",
      description:
        "List all comments on a PR (top-level, replies, and inline). Includes parent_id for client-side threading and the inline anchor (path + line) for review comments.",
      inputSchema,
    },
    async (args) => {
      try {
        const workspace = resolveWorkspace(ctx, args.workspace);
        const path = `/repositories/${encodePathSegment(workspace)}/${encodePathSegment(args.repo_slug)}/pullrequests/${args.pull_request_id}/comments`;

        const { values, truncated, pagesFetched } = await collectAll<PullRequestComment>(
          ctx.http,
          path,
          { pagelen: DEFAULT_PAGELEN },
          { maxPages: args.max_pages ?? 5 },
        );

        const filtered = args.include_deleted ? values : values.filter((c) => !c.deleted);

        const comments = filtered.map((c) => ({
          id: c.id,
          parent_id: c.parent?.id ?? null,
          author: c.user.display_name,
          author_uuid: c.user.uuid,
          content: c.content.raw,
          inline: c.inline
            ? {
                path: c.inline.path,
                to: c.inline.to ?? null,
                from: c.inline.from ?? null,
              }
            : null,
          deleted: c.deleted,
          created_on: c.created_on,
          updated_on: c.updated_on,
          url: c.links?.html?.href,
        }));

        return jsonResult({
          workspace,
          repo_slug: args.repo_slug,
          pull_request_id: args.pull_request_id,
          count: comments.length,
          pages_fetched: pagesFetched,
          truncated,
          comments,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
