/**
 * Tool: `bitbucket_get_pull_request_diffstat`
 *
 * Per-file change summary for a PR — cheap alternative to fetching the
 * full diff. The natural fallback when `bitbucket_get_pull_request_diff`
 * returns `truncated: true`.
 *
 * Auto-pages with a generous default cap because diffstat entries are
 * small; a 10-page cap comfortably covers ~500 files.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { collectAll, DEFAULT_PAGELEN } from "../bitbucket/pagination.js";
import type { DiffStatEntry } from "../bitbucket/types.js";
import { encodePathSegment, errorResult, jsonResult, resolveWorkspace } from "./helpers.js";
import type { ToolContext } from "./index.js";

export const inputSchema = {
  workspace: z
    .string()
    .optional()
    .describe("Workspace slug. Defaults to BITBUCKET_MCP_WORKSPACE if set."),
  repo_slug: z.string().describe("Repository slug (e.g. 'my-service')."),
  pull_request_id: z.number().int().positive().describe("PR number."),
  max_pages: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Maximum pages to fetch (default: 10)."),
};

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "bitbucket_get_pull_request_diffstat",
    {
      title: "Get pull request diffstat",
      description:
        "Per-file change summary for a PR (paths, status, lines added/removed). Cheaper than the full diff.",
      inputSchema,
    },
    async (args) => {
      try {
        const workspace = resolveWorkspace(ctx, args.workspace);
        const path = `/repositories/${encodePathSegment(workspace)}/${encodePathSegment(args.repo_slug)}/pullrequests/${args.pull_request_id}/diffstat`;

        const { values, truncated, pagesFetched } = await collectAll<DiffStatEntry>(
          ctx.http,
          path,
          { pagelen: DEFAULT_PAGELEN },
          { maxPages: args.max_pages ?? 10 },
        );

        const files = values.map((entry) => ({
          status: entry.status,
          path: entry.new?.path ?? entry.old?.path ?? null,
          old_path: entry.old?.path ?? null,
          new_path: entry.new?.path ?? null,
          lines_added: entry.lines_added,
          lines_removed: entry.lines_removed,
        }));

        const totals = files.reduce(
          (acc, f) => {
            acc.lines_added += f.lines_added;
            acc.lines_removed += f.lines_removed;
            return acc;
          },
          { lines_added: 0, lines_removed: 0 },
        );

        return jsonResult({
          workspace,
          repo_slug: args.repo_slug,
          pull_request_id: args.pull_request_id,
          file_count: files.length,
          pages_fetched: pagesFetched,
          truncated,
          totals,
          files,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
