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
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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
 * Gate for write-side tools. When `--allow-writes` is not set, the tool
 * refuses before any network traffic leaves the process. Agents will see
 * a single-line error explaining how to enable it, rather than a
 * generic 403 from Bitbucket.
 */
export function requireWritesAllowed(ctx: ToolContext): void {
  if (!ctx.writesAllowed) {
    throw new Error(
      "Write tools are disabled. Start the server with `bitbucket-mcp --allow-writes` to enable posting comments.",
    );
  }
}
