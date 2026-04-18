/**
 * OAuth 3LO + PKCE login flow.
 *
 * Steps:
 *   1. Bind a loopback HTTP server on an ephemeral port.
 *   2. Build the authorize URL with the chosen redirect_uri and PKCE
 *      challenge; open it in the user's default browser.
 *   3. Receive the authorization code at the /callback endpoint and
 *      validate the `state` parameter.
 *   4. Exchange the code for access + refresh tokens at the token endpoint.
 *   5. Fetch /user to capture the acting identity for whoami.
 *   6. Return a StoredToken ready to be persisted by the caller.
 */

import { AddressInfo, createServer as createHttpServer } from "node:net";
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
  readonly scopes?: readonly string[];
  /** For testing: override the browser opener. Default spawns `start` on Windows. */
  readonly openBrowser?: (url: string) => void;
  /** Overall timeout for the user to complete consent. Defaults to 5 minutes. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function performLogin(opts: PerformLoginOptions): Promise<StoredToken> {
  const pkce = generatePkcePair();
  const state = generateState();

  const { port, server } = await startLoopbackServer();
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

  let code: string;
  try {
    code = await codePromise;
  } finally {
    server.close();
  }

  const tokenResponse = await exchangeCodeForToken({
    clientId: opts.clientId,
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

interface LoopbackServer {
  readonly port: number;
  readonly server: Server;
}

async function startLoopbackServer(): Promise<LoopbackServer> {
  // Pick a free port via the `net` module so the http server can bind to it.
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createHttpServer();
    probe.unref();
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address() as AddressInfo;
      probe.close(() => resolve(addr.port));
    });
    probe.on("error", reject);
  });

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return { port, server };
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
        respond(res, 400, `Authorization denied: ${error}. You can close this tab.`);
        clearTimeout(timer);
        reject(new AuthError(`Authorization denied: ${error} ${description}`.trim()));
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

interface ExchangeArgs {
  readonly clientId: string;
  readonly code: string;
  readonly verifier: string;
  readonly redirectUri: string;
}

async function exchangeCodeForToken(args: ExchangeArgs): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    code_verifier: args.verifier,
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
  });
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
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
