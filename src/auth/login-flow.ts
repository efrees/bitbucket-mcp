/**
 * OAuth 3LO + PKCE login flow.
 *
 * Steps:
 *   1. Bind a loopback HTTP server on a fixed port — Bitbucket requires
 *      an exact match with the registered callback URL including port.
 *   2. Build the authorize URL with the chosen redirect_uri and PKCE
 *      challenge; open it in the user's default browser.
 *   3. Receive the authorization code at the /callback endpoint and
 *      validate the `state` parameter.
 *   4. Exchange the code for access + refresh tokens at the token endpoint.
 *   5. Fetch /user to capture the acting identity for whoami.
 *   6. Return a StoredToken ready to be persisted by the caller.
 */

import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { AuthError } from "../errors.js";
import { log } from "../logger.js";
import { buildAuthorizeUrl, DEFAULT_SCOPES, TOKEN_URL } from "./oauth-endpoints.js";
import { generatePkcePair, generateState } from "./pkce.js";
import type { TokenResponse } from "./session.js";
import type { StoredToken } from "./token-store.js";

export interface PerformLoginOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes?: readonly string[];
  /**
   * Fixed loopback port for the OAuth callback. Must match the port on the
   * registered callback URL in the Bitbucket OAuth consumer, because
   * Bitbucket does exact matching including the port. Defaults to
   * DEFAULT_CALLBACK_PORT; override via config or env var if it collides.
   */
  readonly callbackPort?: number;
  /** For testing: override the browser opener. Default spawns `start` on Windows. */
  readonly openBrowser?: (url: string) => void;
  /** Overall timeout for the user to complete consent. Defaults to 5 minutes. */
  readonly timeoutMs?: number;
}

/**
 * Default fixed callback port. Must stay below 49152 — the dynamic
 * range (49152–65535) is subject to Windows Hyper-V / WSL / Docker
 * reservations that cause `bind()` to fail with EACCES for non-admin
 * processes. 33378 has no well-known service assignment.
 *
 * Overridable via BITBUCKET_MCP_CALLBACK_PORT if it collides on a
 * specific machine; the Bitbucket consumer's callback URL must agree.
 */
export const DEFAULT_CALLBACK_PORT = 33378;

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function performLogin(opts: PerformLoginOptions): Promise<StoredToken> {
  const pkce = generatePkcePair();
  const state = generateState();
  const port = opts.callbackPort ?? DEFAULT_CALLBACK_PORT;

  const server = await startLoopbackServer(port);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const authorizeUrl = buildAuthorizeUrl({
    clientId: opts.clientId,
    redirectUri,
    state,
    pkce,
    ...(opts.scopes !== undefined ? { scopes: opts.scopes } : {}),
  });

  const codePromise = waitForCallback(server, state, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const opener = opts.openBrowser ?? defaultBrowserOpener;
  opener(authorizeUrl);
  log.info("auth: opened browser for consent", { redirectUri });
  // Debug-level log of the full URL so Bitbucket validator errors can be
  // diagnosed without intercepting the browser request.
  log.debug("auth: authorize url", { authorizeUrl });
  // Print the URL to stderr as a manual fallback for headless machines or
  // cases where the browser opener silently fails.
  process.stderr.write(
    `\nIf the browser did not open automatically, paste this URL:\n${authorizeUrl}\n\n`,
  );

  let code: string;
  try {
    code = await codePromise;
  } finally {
    server.close();
  }

  const tokenResponse = await exchangeCodeForToken({
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    code,
    verifier: pkce.verifier,
    redirectUri,
  });

  const user = await fetchIdentity(tokenResponse.access_token);

  return {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    expiresAt: Date.now() + tokenResponse.expires_in * 1000,
    scopes: tokenResponse.scopes ?? (opts.scopes ?? DEFAULT_SCOPES).join(" "),
    user,
  };
}

async function startLoopbackServer(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new AuthError(
            `Port ${port} is already in use. Another process (or a previous login flow that ` +
              `didn't exit cleanly) is holding it. Free the port, or pick another and set ` +
              `BITBUCKET_MCP_CALLBACK_PORT (remembering to update the consumer's callback URL to match).`,
          ),
        );
      } else if (err.code === "EACCES") {
        reject(new AuthError(eaccesMessage(port)));
      } else {
        reject(err);
      }
    });
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return server;
}

function eaccesMessage(port: number): string {
  const base =
    `Permission denied binding 127.0.0.1:${port}. ` +
    `On Windows this almost always means the port is inside a Hyper-V / WSL / Docker Desktop ` +
    `reserved range (which silently blocks non-admin bind() calls). `;
  if (process.platform === "win32") {
    return (
      base +
      `Run this in PowerShell to see the reserved ranges:\n` +
      `    netsh interface ipv4 show excludedportrange protocol=tcp\n` +
      `Pick a port outside those ranges (generally any port below 49152 is safe), ` +
      `then set BITBUCKET_MCP_CALLBACK_PORT to that value AND update the callback URL on ` +
      `your Bitbucket OAuth consumer to match. The two must agree.`
    );
  }
  return (
    base +
    `Ports below 1024 require elevated privileges on Unix. Pick a port ≥ 1024 and set ` +
    `BITBUCKET_MCP_CALLBACK_PORT accordingly, updating the Bitbucket consumer to match.`
  );
}

async function waitForCallback(server: Server, expectedState: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AuthError(`Timed out waiting for OAuth callback after ${timeoutMs}ms.`));
    }, timeoutMs);

    server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1`);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      if (error) {
        const description = url.searchParams.get("error_description") ?? "";
        respond(
          res,
          400,
          `Authorization denied: ${error}${description ? ` — ${description}` : ""}. You can close this tab.`,
        );
        clearTimeout(timer);
        reject(
          new AuthError(
            `Authorization denied: ${error}${description ? ` — ${description}` : ""}. ` +
              troubleshootingHint(error),
          ),
        );
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        respond(res, 400, "Missing code or state.");
        clearTimeout(timer);
        reject(new AuthError("OAuth callback missing code or state parameter."));
        return;
      }
      if (state !== expectedState) {
        respond(res, 400, "State mismatch.");
        clearTimeout(timer);
        reject(new AuthError("OAuth callback returned an unexpected state (possible CSRF)."));
        return;
      }

      respond(res, 200, "Authorization received. You can close this tab and return to your terminal.");
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function respond(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

/**
 * Suggest a likely cause for a given Bitbucket OAuth error code. We keep
 * this terse — a wrong suggestion is worse than none, so we only pattern
 * on codes where the cause is almost always the same.
 */
function troubleshootingHint(errorCode: string): string {
  switch (errorCode) {
    case "unsupported_response_type":
    case "invalid_request":
      return (
        "This usually means the OAuth consumer on Bitbucket is misconfigured. Check that: " +
        "(a) the callback URL matches exactly, including the port (default 33378); " +
        "(b) the permissions are set to Account:Read, Repositories:Read, Pull requests:Read+Write. " +
        "If it still fails, re-save the consumer (Atlassian sometimes caches stale settings)."
      );
    case "redirect_uri_mismatch":
      return (
        "The redirect_uri sent by the client doesn't match what's registered on the OAuth consumer. " +
        "Make sure the consumer's callback URL matches the one printed above exactly, " +
        "including scheme (http), host (127.0.0.1), port, and path (/callback)."
      );
    case "access_denied":
      return "You clicked Deny on the consent screen. Run `bitbucket-mcp login` again to retry.";
    default:
      return "Run with BITBUCKET_MCP_LOG_LEVEL=debug for more detail.";
  }
}

interface ExchangeArgs {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly verifier: string;
  readonly redirectUri: string;
}

async function exchangeCodeForToken(args: ExchangeArgs): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    code_verifier: args.verifier,
    redirect_uri: args.redirectUri,
  });
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      // Bitbucket requires HTTP Basic auth at the token endpoint even
      // when PKCE is in use; passing client_id only (in the body) is
      // rejected with "Client credentials missing".
      Authorization: basicAuth(args.clientId, args.clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new AuthError(`Token exchange failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return (await response.json()) as TokenResponse;
}

function basicAuth(id: string, secret: string): string {
  return `Basic ${Buffer.from(`${id}:${secret}`, "utf8").toString("base64")}`;
}

export { basicAuth };

interface IdentityResponse {
  uuid: string;
  display_name: string;
  account_id?: string;
}

async function fetchIdentity(accessToken: string): Promise<StoredToken["user"]> {
  const response = await fetch("https://api.bitbucket.org/2.0/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new AuthError(`Failed to fetch identity after login (${response.status}).`);
  }
  const json = (await response.json()) as IdentityResponse;
  return {
    uuid: json.uuid,
    displayName: json.display_name,
    accountId: json.account_id,
  };
}

function defaultBrowserOpener(url: string): void {
  if (process.platform === "win32") {
    // rundll32 goes straight to ShellExecute with no shell interpretation.
    //
    // Do not replace with `cmd /c start "" <url>`: cmd.exe splits the
    // command line on `&` before `start` sees its args, truncating any
    // URL whose query string contains ampersands.
    //
    // Do not replace with PowerShell `Start-Process` under detached
    // spawn: the PS process has been observed to exit before ShellExecute
    // completes its hand-off, silently dropping the launch.
    spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return;
  }
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}
