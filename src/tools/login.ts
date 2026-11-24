/**
 * Tool: `bitbucket_login`
 *
 * Runs the interactive 3LO browser login from inside an MCP session and
 * persists the resulting tokens, so a user can (re)authenticate without
 * leaving their MCP client. Registered only in authorization_code mode —
 * client_credentials mode has no login step.
 *
 * This exists because MCP clients' built-in OAuth UX (e.g. Claude Code's
 * /mcp "Reauthenticate") applies to remote HTTP servers only; a local
 * stdio server has to provide its own path to the browser consent flow.
 *
 * The handler blocks until the user completes consent (or the login
 * times out after 5 minutes), which is fine over stdio — the client
 * just sees a slow tool call.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { performLogin } from "../auth/login-flow.js";
import { AuthSession } from "../auth/session.js";
import { errorResult, jsonResult } from "./helpers.js";
import type { ToolContext } from "./index.js";
import type { ScopeGate } from "./scope-gate.js";

export function register(server: McpServer, ctx: ToolContext, scopeGate: ScopeGate): void {
  server.registerTool(
    "bitbucket_login",
    {
      title: "Log in to Bitbucket",
      description:
        "Open the user's browser for Bitbucket OAuth consent and store the resulting tokens. " +
        "Use when other tools fail with 'No stored Bitbucket credentials' or an unrecoverable " +
        "refresh error. Requires the user to be present; waits up to 5 minutes for consent.",
      inputSchema: {},
    },
    async () => {
      try {
        if (!(ctx.auth instanceof AuthSession)) {
          throw new Error(
            "bitbucket_login only applies to authMode=authorization_code. " +
              "This server runs in client_credentials mode, which needs no login step.",
          );
        }
        const token = await performLogin({
          clientId: ctx.config.clientId,
          clientSecret: ctx.config.clientSecret,
          callbackPort: ctx.config.callbackPort,
        });
        await ctx.auth.setToken(token);
        // The new token may carry different scopes than the old one.
        await scopeGate.sync(ctx.auth);
        return jsonResult({
          logged_in_as: token.user.displayName,
          uuid: token.user.uuid,
          scopes: token.scopes,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
