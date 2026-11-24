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
import type { AuthProvider, BitbucketHttpClient } from "../bitbucket/http-client.js";
import * as createPrComment from "./create-pr-comment.js";
import * as createPrInlineComment from "./create-pr-inline-comment.js";
import * as createPullRequest from "./create-pull-request.js";
import * as getPipelineFailures from "./get-pipeline-failures.js";
import * as getPullRequest from "./get-pull-request.js";
import * as getPullRequestDiff from "./get-pull-request-diff.js";
import * as getPullRequestDiffstat from "./get-pull-request-diffstat.js";
import * as listPullRequestComments from "./list-pull-request-comments.js";
import * as listPullRequestStatuses from "./list-pull-request-statuses.js";
import * as listPullRequests from "./list-pull-requests.js";
import * as login from "./login.js";
import * as replyToPrComment from "./reply-to-pr-comment.js";
import { ScopeGate } from "./scope-gate.js";

export interface ToolContext {
  readonly config: AppConfig;
  readonly auth: AuthProvider;
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

/**
 * Registers every tool and returns the gate over the scope-dependent
 * ones. The caller should `sync()` it once at startup; the login tool
 * re-syncs it whenever a new token is stored.
 */
export function registerTools(server: McpServer, ctx: ToolContext): ScopeGate {
  const scopeGate = new ScopeGate();

  // Auth tools. Login is only meaningful in authorization_code mode;
  // registering it conditionally keeps it out of the client's tool list
  // (rather than present-but-erroring) in client_credentials mode.
  if (ctx.config.authMode === "authorization_code") {
    login.register(server, ctx, scopeGate);
  }

  // Read-side tools (always on).
  listPullRequests.register(server, ctx);
  getPullRequest.register(server, ctx);
  getPullRequestDiff.register(server, ctx);
  getPullRequestDiffstat.register(server, ctx);
  listPullRequestComments.register(server, ctx);
  listPullRequestStatuses.register(server, ctx);

  // Read-side tools that need an optional scope. These are hidden from
  // the client when the token doesn't carry it.
  scopeGate.add(
    getPipelineFailures.TOOL_NAME,
    getPipelineFailures.REQUIRED_SCOPE,
    getPipelineFailures.register(server, ctx),
  );

  // Write-side tools — handlers call requireWritesAllowed(ctx) at the top,
  // so they are safe to register even when writes are disabled.
  createPrComment.register(server, ctx);
  replyToPrComment.register(server, ctx);
  createPrInlineComment.register(server, ctx);
  createPullRequest.register(server, ctx);

  return scopeGate;
}
