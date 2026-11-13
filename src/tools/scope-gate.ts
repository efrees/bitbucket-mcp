/**
 * Hides tools whose OAuth scope the current token doesn't carry.
 *
 * Some tools need a scope beyond the required set (see OPTIONAL_SCOPES).
 * A consumer without that permission still gets a working server; the
 * dependent tools just drop out of the client's tool list instead of
 * sitting there and failing with a 403.
 *
 * The granted scopes aren't known when tools are registered — the token
 * is fetched lazily, and in authorization_code mode may not exist until
 * the user logs in — so tools register enabled and `sync()` corrects
 * that once the scopes can be read, and again after each login.
 */

import type { AuthProvider } from "../bitbucket/http-client.js";
import { hasScope } from "../auth/oauth-endpoints.js";
import { log } from "../logger.js";

/** The slice of the SDK's RegisteredTool that the gate needs. */
export interface ToggleableTool {
  enable(): void;
  disable(): void;
}

interface GatedTool {
  readonly name: string;
  readonly scope: string;
  readonly tool: ToggleableTool;
}

export class ScopeGate {
  private readonly gated: GatedTool[] = [];

  public add(name: string, scope: string, tool: ToggleableTool): void {
    this.gated.push({ name, scope, tool });
  }

  /**
   * Enable or disable each gated tool to match the token's scopes. Never
   * throws: if the scopes can't be determined (not logged in, token
   * endpoint unreachable, Bitbucket omitted them) tools stay enabled and
   * the API gets the final say.
   */
  public async sync(auth: AuthProvider): Promise<void> {
    if (this.gated.length === 0) return;
    let granted: readonly string[] | null;
    try {
      granted = await auth.getGrantedScopes();
    } catch (err) {
      log.debug("scope-gate: could not read granted scopes; leaving tools enabled", {
        error: err instanceof Error ? err.message : String(err),
      });
      granted = null;
    }
    for (const { name, scope, tool } of this.gated) {
      if (hasScope(granted, scope)) {
        tool.enable();
      } else {
        log.info("scope-gate: disabling tool; token lacks required scope", { tool: name, scope });
        tool.disable();
      }
    }
  }
}
