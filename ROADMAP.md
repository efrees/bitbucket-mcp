# Bitbucket MCP — Roadmap

An MCP server that gives autonomous agents a way to read pull request context
and reply to PR comments on **Bitbucket Cloud**, so they can participate in
code reviews and act on reviewer feedback.

## Architecture decisions (locked)

| Decision | Choice | Notes |
|---|---|---|
| Language / runtime | TypeScript on Node.js 20+ | Uses `@modelcontextprotocol/sdk` |
| Transport | Local **stdio** only | Each user runs the server on their own machine; no hosted service |
| Auth model | **OAuth 2.0 (3LO) with PKCE** | Each user logs in as themselves; tokens are per-user |
| OAuth consumer | **User-owned** | Each user registers an OAuth consumer in their own Bitbucket workspace and supplies its `client_id` (PKCE means no secret required) |
| Token storage | Encrypted file under user config dir | `~/.config/bitbucket-mcp/tokens.json.enc` (or platform equivalent). No native keychain dependency |
| Multi-account on one machine | Profile-based; v1 supports a default profile, v2 adds named profiles |
| Bitbucket API version | REST API 2.0 | Base: `https://api.bitbucket.org/2.0` |

See [docs/bitbucket-api.md](docs/bitbucket-api.md) for the API surface this
project depends on.

---

## Phase 0 — Project bootstrap

- [x] Repo scaffold (this commit): `package.json`, `tsconfig.json`, `.gitignore`, README, ROADMAP, API doc
- [x] Source skeleton under `src/` that compiles and starts an empty MCP stdio server
- [ ] CI: lint + typecheck + build on PR (pick GitHub Actions or Bitbucket Pipelines — see open questions)

## Phase 1 — Auth foundation

Goal: a CLI command that performs the OAuth 3LO PKCE dance and persists a
refreshable token, plus runtime auto-refresh.

- [ ] `bitbucket-mcp login` command
  - Spawns a loopback HTTP server on an ephemeral port
  - Builds the authorize URL with PKCE `code_challenge` (S256)
  - Opens the user's browser to it
  - Receives the `code` on the loopback callback, exchanges it for tokens
  - Persists `{ access_token, refresh_token, expires_at, scopes, user }` encrypted at rest
- [ ] `bitbucket-mcp logout` command — wipes the stored token file
- [ ] `bitbucket-mcp whoami` command — prints the authenticated user
- [ ] Token refresh middleware in the HTTP client — refresh on 401 or near-expiry
- [ ] Encryption-at-rest implementation (AES-GCM, key derived from a per-install machine secret + user-supplied passphrase fallback)
- [ ] Config loader: read `client_id` (and optional `workspace` default) from `~/.config/bitbucket-mcp/config.json` or env vars

## Phase 2 — Read-side MCP tools (PR context)

Goal: an agent can inspect a PR before deciding what to say.

- [ ] `bitbucket_list_pull_requests` — filter by repo, state, author, reviewer
- [ ] `bitbucket_get_pull_request` — full PR metadata (title, description, branches, reviewers, status)
- [ ] `bitbucket_get_pull_request_diff` — unified diff text, with truncation guardrails for huge PRs
- [ ] `bitbucket_get_pull_request_diffstat` — per-file change summary (cheaper than the full diff)
- [ ] `bitbucket_list_pull_request_comments` — paginated, includes inline anchors and parent/child threading
- [ ] Pagination helper that auto-walks `next` cursors with a configurable cap

## Phase 3 — Write-side MCP tools (reply & review)

Goal: an agent can respond to feedback and leave its own line-anchored review.

- [ ] `bitbucket_reply_to_comment` — post a reply scoped to a parent comment id
- [ ] `bitbucket_create_top_level_comment` — post a non-anchored comment on the PR
- [ ] `bitbucket_create_inline_comment` — anchor to `path` + line number (with `to`/`from` semantics — see API doc)
- [ ] Per-tool permission gate: writes require an explicit `--allow-writes` server flag at startup, or `pullrequest:write` confirmed in the token's scopes (whichever is stricter)

## Phase 4 — Hardening & ergonomics

- [ ] Structured error mapping: surface Bitbucket error envelopes (`{ "type": "error", "error": {...} }`) as MCP tool errors with actionable messages
- [ ] Rate-limit handling: respect `429`, back off using `Retry-After`
- [ ] Logging: stderr-only structured logs (stdout is reserved for MCP framing)
- [ ] Named profiles: `--profile work` to maintain multiple authenticated identities
- [ ] Test suite: contract tests against recorded fixtures; one live smoke test gated on env credentials

## Out of scope for now (revisit later)

- Resolve / unresolve comment threads (deferred)
- Approve / request changes / merge PRs (deferred — higher-blast-radius actions; will need their own permission gate design)
- Repository-level code reads beyond diffs (file fetches, blame, etc.)
- Bitbucket Server / Data Center (this project targets Cloud only)
- Webhooks / push-based agent triggers — out of scope for a stdio MCP

---

## Open questions

These don't block Phase 0, but I'll need answers before the relevant phase
ships. Flagging them here so they don't get lost.

1. **CI host** — Run CI on GitHub Actions or Bitbucket Pipelines? (Phase 0)
2. **Distribution** — Publish to npm as `bitbucket-mcp`, or keep it as a git-installable tool only? Affects how users wire it into their MCP client config. (Phase 1)
3. **Encryption key source** — For the encrypted token file, do we derive the key from (a) a machine-specific value only (transparent, no prompt), (b) a user passphrase (prompted on each `login` and on first refresh after process start), or (c) both? (Phase 1)
4. **Diff size cap** — What's the default max diff size we'll return inline before forcing the agent to fetch the diffstat instead? Suggest 250 KB. (Phase 2)
5. **Inline comment line semantics** — Bitbucket distinguishes `inline.to` (new file line) and `inline.from` (old file line). For the MCP tool surface, do we expose both, or simplify to "side + line"? (Phase 3)
6. **Write confirmation** — Should write tools emit a dry-run preview by default and require an `confirm: true` argument, or trust the agent once `--allow-writes` is on? (Phase 3)
