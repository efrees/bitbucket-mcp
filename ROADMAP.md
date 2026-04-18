# Bitbucket MCP — Roadmap

An MCP server that gives autonomous agents a way to read pull request context
and reply to PR comments on **Bitbucket Cloud**, so they can participate in
code reviews and act on reviewer feedback.

## Architecture decisions (locked)

| Decision | Choice | Notes |
|---|---|---|
| Language / runtime | TypeScript on Node.js 20+ | Uses `@modelcontextprotocol/sdk` |
| Transport | Local **stdio** only | Each user runs the server on their own machine; no hosted service |
| Auth model | **Dual-mode: `client_credentials` (default) or `authorization_code`** | Default is headless: a workspace-scoped token fetched on demand via HTTP Basic + `client_credentials`, no browser. Optional 3LO mode (`authMode: "authorization_code"`) gives user-attributed actions via browser consent + DPAPI-persisted refresh. |
| OAuth consumer | **User-owned, private** | Each user registers a private OAuth consumer in their own Bitbucket workspace and supplies its `clientId` + `clientSecret` (required in both modes). The private designation enables `client_credentials` and matches the "credentials held by the user" reality. |
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

Goal: runtime auth that works headless by default and supports full 3LO
when user-attributed actions are required.

- [x] `client_credentials` auth path (default): POST to the token endpoint
  with HTTP Basic (id:secret) and `grant_type=client_credentials`. Token
  cached in-process; re-fetched on expiry or after a 401. No disk
  persistence, no refresh token (by design for this grant).
- [x] `authorization_code` auth path: full 3LO flow with a fixed-port
  loopback callback. Tokens persisted via DPAPI on Windows. Tokens auto-
  refresh on expiry or 401.
- [x] `bitbucket-mcp login` — 3LO flow (authorization_code mode only)
- [x] `bitbucket-mcp logout` — wipes DPAPI-persisted tokens (authorization_code mode only)
- [x] `bitbucket-mcp whoami` — describes current auth state in either mode
- [x] Token refresh middleware in the HTTP client — refresh on 401 or near-expiry (both modes)
- [x] Encryption-at-rest for stored refresh tokens
  - **Windows:** DPAPI via PowerShell subprocess using `System.Security.Cryptography.ProtectedData` (CurrentUser scope). Ciphertext at `%APPDATA%\bitbucket-mcp\tokens.bin`. Only relevant to authorization_code mode.
  - **macOS / Linux:** `createDefaultTokenStore()` throws `AuthError` on non-Windows platforms. Tracked in open question #3. client_credentials mode has no on-disk persistence, so it's cross-platform today.
- [x] Config loader: reads `authMode`, `clientId`, `clientSecret`, optional `defaultWorkspace` from `<configDir>/config.json` or `BITBUCKET_MCP_*` env vars

## Phase 2 — Read-side MCP tools (PR context)

Goal: an agent can inspect a PR before deciding what to say.

- [x] `bitbucket_list_pull_requests` — filter by repo, state, BBQL query
- [x] `bitbucket_get_pull_request` — full PR metadata, reviewers, participants, approval state
- [x] `bitbucket_get_pull_request_diff` — unified diff text, byte-budgeted truncation (250 KB default)
- [x] `bitbucket_get_pull_request_diffstat` — per-file change summary with totals
- [x] `bitbucket_list_pull_request_comments` — paginated, includes inline anchors and `parent_id` for threading
- [x] Pagination helper that auto-walks `next` cursors with a configurable cap

## Phase 3 — Write-side MCP tools (reply & review)

Goal: an agent can respond to feedback and leave its own line-anchored review.

- [x] `bitbucket_reply_to_pr_comment` — post a reply scoped to a parent comment id
- [x] `bitbucket_create_pr_comment` — post a non-anchored top-level comment
- [x] `bitbucket_create_pr_inline_comment` — anchor to `path` + (side, line); schema makes the "exactly one side" API rule unrepresentable-as-invalid
- [x] Permission gate: `--allow-writes` startup flag is required; `requireWritesAllowed` fails fast before any network call. Scope-level gate (verifying the token actually has `pullrequest:write`) remains nice-to-have but not blocking.

## Phase 4 — Hardening & ergonomics

- [x] Structured error mapping: `BitbucketApiError` carries status + parsed envelope (`message` / `detail` / `code` / `requestId`); tool handlers render this as a pointed message rather than a stack trace.
- [x] Rate-limit handling: up to 3 retries on 429 / 5xx; honors `Retry-After` (seconds or HTTP-date), falls back to capped exponential backoff with jitter.
- [x] Logging: stderr-only JSON logger, level controlled by `BITBUCKET_MCP_LOG_LEVEL`.
- [x] Test suite: `node:test` + `tsx` covering PKCE generation, Retry-After parsing, pagination flattening/truncation, and HTTP client retry + error-envelope behavior. Runs in CI.
- [ ] Named profiles: `--profile work` to maintain multiple authenticated identities (deferred).
- [ ] Contract tests against recorded Bitbucket response fixtures (deferred — current unit suite covers the generic HTTP paths, but per-endpoint fixtures would catch schema drift earlier).
- [ ] Live smoke test gated on env credentials for end-to-end verification against a real workspace (deferred).
- [ ] Scope-level write gate: verify the stored token actually has `pullrequest:write` before running a write tool, on top of the existing `--allow-writes` operator gate (deferred; nice-to-have).

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
4. ~~**Diff size cap** — default max diff size before forcing the agent to fetch diffstat?~~ **Resolved: 250 KB default, 2 MB hard ceiling.** Configurable per call via the `max_bytes` argument on `bitbucket_get_pull_request_diff`; UTF-8-safe truncation with an explicit marker pointing at the diffstat tool.
5. ~~**Inline comment line semantics** — expose raw `to`/`from` or simplify?~~ **Resolved: `(side: 'new'|'old', line: number)`.** The tool schema makes Bitbucket's "exactly one of to/from per comment" rule unrepresentable-as-invalid.
6. ~~**Write confirmation** — dry-run preview + `confirm: true`, or trust the agent once `--allow-writes` is on?~~ **Resolved: trust the agent once `--allow-writes` is on.** The startup flag is the operator-level gate; requiring a per-call confirmation on top would cripple agent autonomy. Operators who want a stricter policy can simply not pass `--allow-writes`.
