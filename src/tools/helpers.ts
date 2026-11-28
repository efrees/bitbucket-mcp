/**
 * Shared helpers for MCP tool handlers.
 *
 * - `jsonResult` renders a JSON payload as a tool content block. Agents
 *   parse this on the other side, so we keep it pretty-printed for
 *   readability in transcripts.
 * - `errorResult` turns an Error into the MCP error-shaped content block.
 * - `resolveWorkspace` fills in the configured default workspace when the
 *   caller didn't specify one, or throws a clear error.
 * - `encodePathSegment` URL-encodes repo_slug / workspace values that may
 *   contain characters like `/` or spaces.
 * - `pendingInput` / `pendingCommentFields` implement the shared draft
 *   (pending) option of the comment-posting tools.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BitbucketApiError } from "../errors.js";
import type { ToolContext } from "./index.js";

export function jsonResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(err: unknown): CallToolResult {
  const message =
    err instanceof BitbucketApiError
      ? `Bitbucket ${err.status}: ${err.message}${err.detail ? ` — ${err.detail}` : ""}`
      : err instanceof Error
        ? err.message
        : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

export function resolveWorkspace(ctx: ToolContext, supplied?: string | undefined): string {
  const ws = supplied ?? ctx.config.defaultWorkspace;
  if (!ws) {
    throw new Error(
      "workspace not specified and no default is configured. " +
        'Pass "workspace" to this tool or set BITBUCKET_MCP_WORKSPACE / defaultWorkspace in config.json.',
    );
  }
  return ws;
}

export function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Shared `pending` input for the comment-posting tools. Bitbucket keeps a
 * pending comment as a draft visible only to its author until they press
 * "Finish Review" in the web UI. The public API can set `pending` on
 * create but has no way to publish a draft (PUT rejects the field).
 */
export const pendingInput = z
  .boolean()
  .optional()
  .describe(
    "Post as a draft (pending) review comment: only you can see it until you publish your review with 'Finish Review' in the Bitbucket web UI. The API cannot publish it for you. Defaults to false (published immediately). Requires authMode=authorization_code. The result's `pending` field reports what Bitbucket stored.",
  );

/**
 * Turn a tool's `pending` argument into the fields to merge into the
 * comment POST body. Omitted or false sends nothing, leaving the request
 * exactly as it was before drafts were supported.
 *
 * Refuses `pending: true` under client_credentials: the draft would belong
 * to the OAuth consumer, which can't sign in to the web UI to publish it,
 * so it would sit invisible to everyone. Throws before any network call.
 */
export function pendingCommentFields(
  ctx: ToolContext,
  requested: boolean | undefined,
): { pending?: true } {
  if (requested !== true) return {};
  if (ctx.config.authMode !== "authorization_code") {
    throw new Error(
      "Draft (pending) comments require authMode=authorization_code. Under client_credentials " +
        "the draft would belong to the OAuth consumer, which can't sign in to the Bitbucket web UI " +
        "to publish it, and the API has no publish call, so nobody would ever see it. " +
        "Omit `pending` to post a published comment.",
    );
  }
  return { pending: true };
}

/**
 * Gate for write-side tools. When `--allow-writes` is not set, the tool
 * refuses before any network traffic leaves the process. Agents will see
 * a single-line error explaining how to enable it, rather than a
 * generic 403 from Bitbucket.
 */
export function requireWritesAllowed(ctx: ToolContext): void {
  if (!ctx.writesAllowed) {
    throw new Error(
      "Write tools are disabled. Start the server with `bitbucket-mcp --allow-writes` to enable them.",
    );
  }
}
