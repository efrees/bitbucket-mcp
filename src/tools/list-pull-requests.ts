/**
 * Tool: `bitbucket_list_pull_requests`
 *
 * Lists PRs in a repository, optionally filtered by state. State is
 * Bitbucket's enum (OPEN / MERGED / DECLINED / SUPERSEDED) and accepts an
 * array for queries like "open + merged in the last week".
 *
 * Auto-pages up to `max_pages` (default 2 = ~100 PRs) to keep agents
 * from walking huge repositories accidentally. The response includes a
 * `truncated` flag so the agent can decide whether to narrow the query.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { collectAll, DEFAULT_PAGELEN } from "../bitbucket/pagination.js";
import type { PullRequest } from "../bitbucket/types.js";
import { encodePathSegment, errorResult, jsonResult, resolveWorkspace } from "./helpers.js";
import type { ToolContext } from "./index.js";

const PR_STATE = z.enum(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]);

export const inputSchema = {
  workspace: z
    .string()
    .optional()
    .describe("Workspace slug. Defaults to BITBUCKET_MCP_WORKSPACE if set."),
  repo_slug: z.string().describe("Repository slug (e.g. 'my-service')."),
  state: z
    .union([PR_STATE, z.array(PR_STATE)])
    .optional()
    .describe("Filter by PR state. Default: OPEN only."),
  query: z
    .string()
    .optional()
    .describe(
      'Bitbucket query language (BBQL) filter. Examples: author.uuid="{...}", reviewers.uuid="{...}".',
    ),
  max_pages: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Maximum pages to fetch (default: 2, pagelen 50 per page)."),
};

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "bitbucket_list_pull_requests",
    {
      title: "List pull requests",
      description:
        "List pull requests in a Bitbucket Cloud repository, optionally filtered by state or BBQL query.",
      inputSchema,
    },
    async (args) => {
      try {
        const workspace = resolveWorkspace(ctx, args.workspace);
        const states = args.state
          ? Array.isArray(args.state)
            ? args.state
            : [args.state]
          : ["OPEN"];
        const path = `/repositories/${encodePathSegment(workspace)}/${encodePathSegment(args.repo_slug)}/pullrequests`;
        const query: Record<string, string | number | string[] | undefined> = {
          pagelen: DEFAULT_PAGELEN,
          state: states,
        };
        if (args.query) query["q"] = args.query;

        const { values, truncated, pagesFetched } = await collectAll<PullRequest>(
          ctx.http,
          path,
          query,
          { maxPages: args.max_pages ?? 2 },
        );

        return jsonResult({
          workspace,
          repo_slug: args.repo_slug,
          count: values.length,
          pages_fetched: pagesFetched,
          truncated,
          pull_requests: values.map((pr) => ({
            id: pr.id,
            title: pr.title,
            state: pr.state,
            author: pr.author?.display_name,
            source_branch: pr.source.branch.name,
            destination_branch: pr.destination.branch.name,
            created_on: pr.created_on,
            updated_on: pr.updated_on,
            url: pr.links?.html?.href,
          })),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
