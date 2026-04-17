/**
 * Tool: `bitbucket_get_pull_request`
 *
 * Fetches full metadata for a single PR, including reviewer approval
 * state. Agents typically call this before deciding what to say on a
 * review, so we surface participants and their current `approved` /
 * changes_requested state rather than only the top-level fields.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PullRequest } from "../bitbucket/types.js";
import { encodePathSegment, errorResult, jsonResult, resolveWorkspace } from "./helpers.js";
import type { ToolContext } from "./index.js";

export const inputSchema = {
  workspace: z
    .string()
    .optional()
    .describe("Workspace slug. Defaults to BITBUCKET_MCP_WORKSPACE if set."),
  repo_slug: z.string().describe("Repository slug (e.g. 'my-service')."),
  pull_request_id: z.number().int().positive().describe("PR number (integer id, not title)."),
};

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "bitbucket_get_pull_request",
    {
      title: "Get pull request",
      description:
        "Fetch full metadata for a single pull request, including reviewers, participants, and approval state.",
      inputSchema,
    },
    async (args) => {
      try {
        const workspace = resolveWorkspace(ctx, args.workspace);
        const path = `/repositories/${encodePathSegment(workspace)}/${encodePathSegment(args.repo_slug)}/pullrequests/${args.pull_request_id}`;
        const pr = await ctx.http.requestJson<PullRequest>(path);

        return jsonResult({
          id: pr.id,
          title: pr.title,
          description: pr.description ?? "",
          state: pr.state,
          author: pr.author?.display_name,
          source_branch: pr.source.branch.name,
          destination_branch: pr.destination.branch.name,
          reviewers: pr.reviewers?.map((r) => r.display_name) ?? [],
          participants:
            pr.participants?.map((p) => ({
              user: p.user.display_name,
              role: p.role,
              approved: p.approved,
              state: p.state ?? null,
            })) ?? [],
          created_on: pr.created_on,
          updated_on: pr.updated_on,
          url: pr.links?.html?.href,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
