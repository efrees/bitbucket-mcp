/**
 * Helpers for exercising a tool handler without an MCP transport or a
 * network: capture the callback a tool module registers, and stand in
 * for the HTTP client with one that records each request and replies
 * with a canned response.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BitbucketHttpClient, RequestOptions } from "../src/bitbucket/http-client.ts";
import type { AuthMode } from "../src/config.ts";
import type { ToolContext } from "../src/tools/index.ts";

export interface RecordedRequest {
  readonly path: string;
  readonly options: RequestOptions;
}

export interface StubHttp {
  readonly client: BitbucketHttpClient;
  readonly requests: RecordedRequest[];
}

/** HTTP stub whose `requestJson` records the call and returns `response`. */
export function stubHttp(response: unknown): StubHttp {
  const requests: RecordedRequest[] = [];
  const client = {
    async requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
      requests.push({ path, options });
      return response as T;
    },
  } as unknown as BitbucketHttpClient;
  return { client, requests };
}

export function makeContext(
  http: BitbucketHttpClient,
  overrides: { authMode?: AuthMode; writesAllowed?: boolean } = {},
): ToolContext {
  return {
    config: {
      authMode: overrides.authMode ?? "authorization_code",
      clientId: "test-client",
      clientSecret: "test-secret",
      defaultWorkspace: "ws",
      callbackPort: 33378,
    },
    auth: {} as ToolContext["auth"],
    http,
    writesAllowed: overrides.writesAllowed ?? true,
  };
}

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

/** Run a tool module's `register` against a fake server and return its handler. */
export function captureHandler(
  register: (server: McpServer, ctx: ToolContext) => void,
  ctx: ToolContext,
): Handler {
  let handler: Handler | undefined;
  const server = {
    registerTool(_name: string, _config: unknown, cb: Handler) {
      handler = cb;
    },
  } as unknown as McpServer;
  register(server, ctx);
  if (!handler) throw new Error("tool module did not register a handler");
  return handler;
}

/** Parse the JSON payload of a successful tool result. */
export function parseResult(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (result.isError || !first || first.type !== "text") {
    throw new Error(`expected a JSON result, got: ${JSON.stringify(result)}`);
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

/** A minimal stored comment as Bitbucket returns it from POST /comments. */
export function storedComment(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 101,
    content: { raw: "body" },
    user: { display_name: "Test User", uuid: "{u}" },
    created_on: "2026-11-27T00:00:00Z",
    updated_on: "2026-11-27T00:00:00Z",
    deleted: false,
    ...extra,
  };
}
