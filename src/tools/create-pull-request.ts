/**
 * Tool: `bitbucket_create_pull_request`
 *
 * Opens a new PR from one branch to another in the same repository.
 *
 * Design choices (see ROADMAP Phase 5):
 * - **Minimal schema.** First version takes only source/destination
 *   branches, title, description, and a `draft` flag. Reviewers,
 *   `close_source_branch`, and other knobs stay out until an agent
 *   actually needs them. Adding fields is cheap; removing them later
 *   isn't.
 * - **Same-repository only.** The source branch is always resolved in
 *   the repo named in the path. We do not accept a cross-repo source
 *   (fork). This closes an injection vector where a compromised agent
 *   could open a PR from an attacker-controlled fork into a sensitive
 *   branch to trigger privileged CI.
 * - **Draft by default.** `draft` defaults to `true`; publishing takes
 *   an explicit `draft: false`. The extra deliberation to open a
 *   ready-for-review PR is cheap, and the realistic failure mode is
 *   "agent shipped a half-baked PR that pinged five humans." If the
 *   target workspace's plan doesn't support drafts, Bitbucket surfaces
 *   the error — we do not silently degrade.
 * - **No merge, no approve.** The token already carries
 *   `pullrequest:write`, which is enough to merge or approve. We
 *   deliberately don't expose tools for those — they're higher
 *   blast-radius, and under `authorization_code` mode an approve tool
 *   would let an agent self-approve under the user's identity.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PullRequest } from "../bitbucket/types.js";
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
  source_branch: z
    .string()
    .min(1)
    .describe(
      "Name of the branch to merge from. Must exist in the same repository — this tool does not open cross-repo (fork) PRs.",
    ),
  destination_branch: z
    .string()
    .min(1)
    .describe(
      "Name of the branch to merge into (e.g. 'main'). Required — no implicit default, to avoid accidentally targeting a protected branch.",
    ),
  title: z
    .string()
    .min(1)
    .describe("PR title. Required — Bitbucket rejects empty titles."),
  description: z
    .string()
    .optional()
    .describe("Optional PR description (raw Markdown)."),
  draft: z
    .boolean()
    .optional()
    .describe(
      "Open as a draft. Defaults to true; pass false to open ready-for-review. Draft PRs require a Bitbucket workspace plan that supports them; the create call surfaces the Bitbucket error if the plan does not.",
    ),
};

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "bitbucket_create_pull_request",
    {
      title: "Create pull request",
      description:
        "Open a new PR from source_branch to destination_branch in the given repository. Draft by default; pass draft:false to open ready-for-review. Source must be a branch in the same repo (no fork PRs).",
      inputSchema,
    },
    async (args) => {
      try {
        requireWritesAllowed(ctx);
        const workspace = resolveWorkspace(ctx, args.workspace);
        const path = `/repositories/${encodePathSegment(workspace)}/${encodePathSegment(args.repo_slug)}/pullrequests`;

        const body: Record<string, unknown> = {
          title: args.title,
          source: { branch: { name: args.source_branch } },
          destination: { branch: { name: args.destination_branch } },
          draft: args.draft ?? true,
        };
        if (args.description !== undefined) {
          body.description = args.description;
        }

        const pr = await ctx.http.requestJson<PullRequest>(path, {
          method: "POST",
          jsonBody: body,
        });

        return jsonResult({
          id: pr.id,
          title: pr.title,
          state: pr.state,
          source_branch: pr.source.branch.name,
          destination_branch: pr.destination.branch.name,
          author: pr.author?.display_name,
          created_on: pr.created_on,
          url: pr.links?.html?.href,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
