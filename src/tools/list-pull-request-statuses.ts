/**
 * Tool: `bitbucket_list_pull_request_statuses`
 *
 * Build / CI statuses reported against a PR (Bitbucket Pipelines and any
 * third-party CI that posts commit statuses). Lets an agent answer "is
 * this PR green?" and follow the `url` of a failing build.
 *
 * Alongside the raw list we return per-state counts and a rolled-up
 * `overall_state`, so the common case doesn't require the agent to
 * reduce the list itself.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { collectAll, DEFAULT_PAGELEN } from "../bitbucket/pagination.js";
import type { CommitStatus, CommitStatusState } from "../bitbucket/types.js";
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

/**
 * Worst-first precedence for the roll-up: one failed build makes the PR
 * red no matter how many others passed, and anything still running keeps
 * it from being called green.
 */
const STATE_PRECEDENCE: readonly CommitStatusState[] = [
  "FAILED",
  "STOPPED",
  "INPROGRESS",
  "SUCCESSFUL",
];

export type OverallState = CommitStatusState | "NONE";

export interface StatusSummary {
  readonly overall_state: OverallState;
  readonly counts: Record<CommitStatusState, number>;
}

/** Reduce a list of statuses to per-state counts and a single roll-up. */
export function summarizeStatuses(statuses: readonly Pick<CommitStatus, "state">[]): StatusSummary {
  const counts: Record<CommitStatusState, number> = {
    SUCCESSFUL: 0,
    FAILED: 0,
    INPROGRESS: 0,
    STOPPED: 0,
  };
  for (const s of statuses) {
    // Guard against states Bitbucket may add later: don't let an unknown
    // value create a NaN bucket or silently count as green.
    if (s.state in counts) counts[s.state] += 1;
  }
  const overall = STATE_PRECEDENCE.find((state) => counts[state] > 0) ?? "NONE";
  return { overall_state: overall, counts };
}

/**
 * Bitbucket Pipelines statuses link to the run's results page, whose URL
 * ends in the build number (`.../pipelines/results/42`, or the older
 * `.../addon/pipelines/home#!/results/42`). Returns null for statuses
 * posted by any other CI system.
 */
export function pipelineBuildNumber(url: string | undefined): number | null {
  if (!url) return null;
  const match = /^https:\/\/bitbucket\.org\/.*\/pipelines\/(?:home#!\/)?results\/(\d+)/.exec(url);
  return match ? Number(match[1]) : null;
}

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "bitbucket_list_pull_request_statuses",
    {
      title: "List pull request build statuses",
      description:
        "Build/CI statuses reported on a PR (state, name, link to the build), plus per-state counts and " +
        "a rolled-up overall_state: FAILED > STOPPED > INPROGRESS > SUCCESSFUL, or NONE when no builds have reported. " +
        "For a failed status with a pipeline_build_number, call bitbucket_get_pipeline_failures for the failing tests and log.",
      inputSchema,
    },
    async (args) => {
      try {
        const workspace = resolveWorkspace(ctx, args.workspace);
        const path = `/repositories/${encodePathSegment(workspace)}/${encodePathSegment(args.repo_slug)}/pullrequests/${args.pull_request_id}/statuses`;

        const { values, truncated, pagesFetched } = await collectAll<CommitStatus>(
          ctx.http,
          path,
          { pagelen: DEFAULT_PAGELEN },
          { maxPages: args.max_pages ?? 10 },
        );

        const statuses = values.map((s) => ({
          key: s.key,
          name: s.name ?? null,
          state: s.state,
          description: s.description ?? null,
          url: s.url ?? null,
          // Non-null only for Bitbucket Pipelines runs; pass it to
          // bitbucket_get_pipeline_failures to see why a build failed.
          pipeline_build_number: pipelineBuildNumber(s.url),
          refname: s.refname ?? null,
          created_on: s.created_on ?? null,
          updated_on: s.updated_on ?? null,
        }));

        return jsonResult({
          workspace,
          repo_slug: args.repo_slug,
          pull_request_id: args.pull_request_id,
          ...summarizeStatuses(statuses),
          status_count: statuses.length,
          pages_fetched: pagesFetched,
          truncated,
          statuses,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
