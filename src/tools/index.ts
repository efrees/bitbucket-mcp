/**
 * Tool registry.
 *
 * `registerTools` is the single place that wires MCP tools into the
 * server. Each tool module exports a `register(server, ctx)` function and
 * is called from here. New tools are added by importing their register
 * function and calling it below.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config.js";
import type { AuthSession } from "../auth/session.js";
import type { BitbucketHttpClient } from "../bitbucket/http-client.js";

export interface ToolContext {
  readonly config: AppConfig;
  readonly auth: AuthSession;
  readonly http: BitbucketHttpClient;
}

export function registerTools(server: McpServer, _ctx: ToolContext): void {
  // Tools will be registered here in Phase 2 / Phase 3 commits:
  //   listPullRequests.register(server, ctx)
  //   getPullRequest.register(server, ctx)
  //   ...
  // The server starts with zero tools for now, which is still useful —
  // clients can connect, list tools, and see the (empty) set.
  void server;
}
