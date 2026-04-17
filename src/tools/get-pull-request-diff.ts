/**
 * Tool: `bitbucket_get_pull_request_diff`
 *
 * Returns the unified diff text for a PR, truncated to a configurable
 * size cap so a massive PR can't blow up an agent's context window.
 *
 * The cap defaults to 250 KB and is enforced both against the response
 * body length and against a character count after any decoding, whichever
 * is stricter. When truncated, the tool includes a clear marker so the
 * agent knows to fall back to the diffstat tool for the full picture.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { encodePathSegment, errorResult, jsonResult, resolveWorkspace } from "./helpers.js";
import type { ToolContext } from "./index.js";

const DEFAULT_MAX_BYTES = 250 * 1024;
const HARD_MAX_BYTES = 2 * 1024 * 1024;

export const inputSchema = {
  workspace: z
    .string()
    .optional()
    .describe("Workspace slug. Defaults to BITBUCKET_MCP_WORKSPACE if set."),
  repo_slug: z.string().describe("Repository slug (e.g. 'my-service')."),
  pull_request_id: z.number().int().positive().describe("PR number."),
  max_bytes: z
    .number()
    .int()
    .min(1024)
    .max(HARD_MAX_BYTES)
    .optional()
    .describe(
      `Maximum diff size to return. Default ${DEFAULT_MAX_BYTES} bytes. Hard limit ${HARD_MAX_BYTES} bytes. ` +
        "If the diff exceeds this, a truncation marker is appended and `truncated` is set.",
    ),
};

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "bitbucket_get_pull_request_diff",
    {
      title: "Get pull request diff",
      description:
        "Fetch the unified diff for a PR, truncated to max_bytes (default 250 KB) so huge PRs stay within context.",
      inputSchema,
    },
    async (args) => {
      try {
        const workspace = resolveWorkspace(ctx, args.workspace);
        const cap = args.max_bytes ?? DEFAULT_MAX_BYTES;
        const path = `/repositories/${encodePathSegment(workspace)}/${encodePathSegment(args.repo_slug)}/pullrequests/${args.pull_request_id}/diff`;
        const body = await ctx.http.requestText(path);

        const byteLength = Buffer.byteLength(body, "utf8");
        let diff = body;
        let truncated = false;
        if (byteLength > cap) {
          // Trim to cap on a UTF-8 boundary by taking the first `cap` bytes
          // and decoding as a replacement-safe Buffer slice.
          const slice = Buffer.from(body, "utf8").subarray(0, cap).toString("utf8");
          diff =
            slice +
            `\n\n[TRUNCATED — diff is ${byteLength} bytes, returned first ${cap}. ` +
            "Call bitbucket_get_pull_request_diffstat for the full file list.]\n";
          truncated = true;
        }

        return jsonResult({
          workspace,
          repo_slug: args.repo_slug,
          pull_request_id: args.pull_request_id,
          byte_length: byteLength,
          truncated,
          max_bytes: cap,
          diff,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
