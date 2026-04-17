/**
 * Tool registry.
 *
 * `registerTools` is the single place that wires MCP tools into the
 * server. Each tool module exports a `register(server, ctx)` function
 * and is called from here. New tools are added by importing the
 * module and appending one call below.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config.js";
import type { AuthSession } from "../auth/session.js";
import type { BitbucketHttpClient } from "../bitbucket/http-client.js";
import * as getPullRequest from "./get-pull-request.js";
import * as getPullRequestDiff from "./get-pull-request-diff.js";
import * as getPullRequestDiffstat from "./get-pull-request-diffstat.js";
import * as listPullRequestComments from "./list-pull-request-comments.js";
import * as listPullRequests from "./list-pull-requests.js";

export interface ToolContext {
  readonly config: AppConfig;
  readonly auth: AuthSession;
  readonly http: BitbucketHttpClient;
  /**
   * True when the operator started the MCP server with `--allow-writes`.
   * Write-side tools refuse to run when this is false, regardless of the
   * OAuth scope actually granted on the token. This is a belt-and-braces
   * gate: even if the user accidentally grants pullrequest:write to the
   * consumer, the server won't post until the operator opts in.
   */
  readonly writesAllowed: boolean;
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  listPullRequests.register(server, ctx);
  getPullRequest.register(server, ctx);
  getPullRequestDiff.register(server, ctx);
  getPullRequestDiffstat.register(server, ctx);
  listPullRequestComments.register(server, ctx);
}
