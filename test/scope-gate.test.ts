import assert from "node:assert/strict";
import { test } from "node:test";
import { hasScope, parseScopes } from "../src/auth/oauth-endpoints.js";
import type { AuthProvider } from "../src/bitbucket/http-client.js";
import { ScopeGate } from "../src/tools/scope-gate.js";

function authWithScopes(scopes: () => Promise<readonly string[] | null>): AuthProvider {
  return {
    getAccessToken: async () => "token",
    refreshAccessToken: async () => "token",
    getGrantedScopes: scopes,
  };
}

function fakeTool() {
  const state = { enabled: true };
  return {
    state,
    enable: () => {
      state.enabled = true;
    },
    disable: () => {
      state.enabled = false;
    },
  };
}

test("parseScopes splits on spaces and commas; missing scopes are unknown", () => {
  assert.deepEqual(parseScopes("account pullrequest:write  pipeline"), [
    "account",
    "pullrequest:write",
    "pipeline",
  ]);
  assert.deepEqual(parseScopes("account, pipeline"), ["account", "pipeline"]);
  assert.deepEqual(parseScopes(""), []);
  assert.equal(parseScopes(undefined), null);
});

test("hasScope: exact match, implied by a stronger variant, or unknown", () => {
  assert.equal(hasScope(["account", "pipeline"], "pipeline"), true);
  assert.equal(hasScope(["pipeline:write"], "pipeline"), true);
  assert.equal(hasScope(["account", "pullrequest"], "pipeline"), false);
  assert.equal(hasScope(["pipelines"], "pipeline"), false);
  assert.equal(hasScope(null, "pipeline"), true);
});

test("ScopeGate disables a tool whose scope the token lacks", async () => {
  const gate = new ScopeGate();
  const tool = fakeTool();
  gate.add("t", "pipeline", tool);
  await gate.sync(authWithScopes(async () => ["account", "pullrequest"]));
  assert.equal(tool.state.enabled, false);
});

test("ScopeGate re-enables a tool once a later token carries the scope", async () => {
  const gate = new ScopeGate();
  const tool = fakeTool();
  gate.add("t", "pipeline", tool);
  await gate.sync(authWithScopes(async () => ["account"]));
  await gate.sync(authWithScopes(async () => ["account", "pipeline"]));
  assert.equal(tool.state.enabled, true);
});

test("ScopeGate leaves tools enabled when scopes are unknown or unreadable", async () => {
  const gate = new ScopeGate();
  const tool = fakeTool();
  gate.add("t", "pipeline", tool);
  await gate.sync(authWithScopes(async () => null));
  assert.equal(tool.state.enabled, true);
  await gate.sync(
    authWithScopes(async () => {
      throw new Error("not logged in");
    }),
  );
  assert.equal(tool.state.enabled, true);
});
