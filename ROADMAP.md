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
| Token storage | Encrypted file under user config dir | Windows: **DPAPI** (`CryptProtectData`, user-scoped) — silent, no passphrase. macOS/Linux: TBD (see open question #3) |
| Multi-account on one machine | Profile-based; v1 supports a default profile, v2 adds named profiles |
| Bitbucket API version | REST API 2.0 | Base: `https://api.bitbucket.org/2.0` |

See [docs/bitbucket-api.md](docs/bitbucket-api.md) for the API surface this
project depends on.

---

## Phase 0 — Project bootstrap

- [x] Repo scaffold (this commit): `package.json`, `tsconfig.json`, `.gitignore`, README, ROADMAP, API doc
- [x] Source skeleton under `src/` that compiles and starts an empty MCP stdio server
- [x] CI: typecheck + build on PR and push to `main` via GitHub Actions (`.github/workflows/ci.yml`)

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
- [ ] Encryption-at-rest implementation
  - **Windows (priority):** DPAPI via `CryptProtectData` / `CryptUnprotectData` with `CRYPTPROTECT_UI_FORBIDDEN`. Scope: current user. Ciphertext stored as-is in `%APPDATA%\bitbucket-mcp\tokens.bin`. Silent on every run.
  - **macOS / Linux:** deferred — initial builds on those platforms will refuse to start if DPAPI is unavailable, with a clear error. Resolution tracked in open question #3.
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

1. ~~**CI host** — GitHub Actions or Bitbucket Pipelines?~~ **Resolved: GitHub Actions** (project will be hosted on GitHub).
2. ~~**Distribution** — Publish to npm as `bitbucket-mcp`, or keep it as a git-installable tool only?~~ **Resolved: git-only for now.** Users install via `git clone` + `npm install` + `npm run build`, then point their MCP client at the built `dist/index.js`. Revisit if/when the tool stabilizes enough for an npm release.
3. **Encryption — non-Windows platforms.** Windows uses DPAPI (resolved). For macOS and Linux, what's the fallback? Options: (a) native OS keychain (macOS Keychain via Security framework, Linux Secret Service / libsecret) — silent but adds a native-module dependency and has Linux-on-headless-server edge cases; (b) passphrase-derived AES-GCM, prompted at `login` and cached in-memory per process; (c) refuse to run on those platforms until a user explicitly opts in. Leaning (a), but not a blocker until we need cross-platform. (Phase 1+)
4. **Diff size cap** — What's the default max diff size we'll return inline before forcing the agent to fetch the diffstat instead? Suggest 250 KB. (Phase 2)
5. **Inline comment line semantics** — Bitbucket distinguishes `inline.to` (new file line) and `inline.from` (old file line). For the MCP tool surface, do we expose both, or simplify to "side + line"? (Phase 3)
6. **Write confirmation** — Should write tools emit a dry-run preview by default and require an `confirm: true` argument, or trust the agent once `--allow-writes` is on? (Phase 3)
