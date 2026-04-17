/**
 * Bitbucket Cloud OAuth endpoint constants and URL builders.
 *
 * See docs/bitbucket-api.md §1 for the full flow. Centralising these
 * URLs here keeps the login flow and the refresher from drifting out of
 * sync.
 */

import type { PkcePair } from "./pkce.js";

export const AUTHORIZE_URL = "https://bitbucket.org/site/oauth2/authorize";
export const TOKEN_URL = "https://bitbucket.org/site/oauth2/access_token";

/** Scopes we request on every login. See docs/bitbucket-api.md §1 for rationale. */
export const DEFAULT_SCOPES = ["account", "repository", "pullrequest", "pullrequest:write"];

export interface BuildAuthorizeUrlArgs {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly pkce: PkcePair;
  readonly scopes?: readonly string[];
}

export function buildAuthorizeUrl(args: BuildAuthorizeUrlArgs): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("state", args.state);
  url.searchParams.set("code_challenge", args.pkce.challenge);
  url.searchParams.set("code_challenge_method", args.pkce.method);
  url.searchParams.set("scope", (args.scopes ?? DEFAULT_SCOPES).join(" "));
  return url.toString();
}
