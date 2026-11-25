# Bitbucket MCP — Roadmap

An MCP server that gives autonomous agents a way to read pull request context
and reply to PR comments on **Bitbucket Cloud**, so they can participate in
code reviews and act on reviewer feedback.

## Architecture decisions (locked)

| Decision | Choice | Notes |
|---|---|---|
| Language / runtime | TypeScript on Node.js 22+ | Uses `@modelcontextprotocol/sdk` |
| Transport | Local **stdio** only | Each user runs the server on their own machine; no hosted service |
| Auth model | **Dual-mode: `client_credentials` (default) or `authorization_code`** | Default is headless: a workspace-scoped token fetched on demand via HTTP Basic + `client_credentials`, no browser. Optional 3LO mode (`authMode: "authorization_code"`) gives user-attributed actions via browser consent + DPAPI-persisted refresh. |
| OAuth consumer | **User-owned, private** | Each user registers a private OAuth consumer in their own Bitbucket workspace and supplies its `clientId` + `clientSecret` (required in both modes). The private designation enables `client_credentials` and matches the "credentials held by the user" reality. The secret lives in the OS secret vault (`set-secret`) or an env var — not plaintext config. |
| Token storage | OS-native secret vault | Windows: **DPAPI** (`CryptProtectData`, user-scoped). macOS: **Keychain** (via the bundled `security` CLI). Linux: **Secret Service / libsecret** (via `secret-tool`). All silent, no passphrase, no native npm modules. |
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
- [x] `bitbucket_login` MCP tool — same 3LO flow, triggerable from inside an MCP client (registered in authorization_code mode only). Exists because MCP clients' OAuth UX (e.g. Claude Code `/mcp` → Reauthenticate) covers remote HTTP servers only, not local stdio servers.
- [x] `bitbucket-mcp logout` — wipes DPAPI-persisted tokens (authorization_code mode only)
- [x] `bitbucket-mcp whoami` — describes current auth state in either mode
- [x] Token refresh middleware in the HTTP client — refresh on 401 or near-expiry (both modes)
- [x] Encryption-at-rest for stored refresh tokens (only relevant to authorization_code mode; client_credentials never touches disk)
  - **Windows:** DPAPI via PowerShell subprocess using `System.Security.Cryptography.ProtectedData` (CurrentUser scope). Ciphertext at `%APPDATA%\bitbucket-mcp\tokens.bin`.
  - **macOS:** login Keychain via the bundled `security` CLI (generic password, service `bitbucket-mcp`).
  - **Linux:** Secret Service via `secret-tool` (libsecret). Requires a running keyring daemon; headless machines fall back to env-var credentials.
  - All three sit behind the `SecretVault` interface (`src/auth/secret-vault.ts`); secrets travel over stdin/stdout, never argv.
- [x] Config loader: reads `authMode`, `clientId`, optional `defaultWorkspace` from `<configDir>/config.json` or `BITBUCKET_MCP_*` env vars
- [x] Client secret at rest: `bitbucket-mcp set-secret` / `clear-secret` keep the OAuth consumer secret in the OS secret vault instead of plaintext config. Resolution order: `BITBUCKET_MCP_CLIENT_SECRET` env var → vault → plaintext `clientSecret` in config.json (deprecated; logs a warning steering to `set-secret`)

## Phase 2 — Read-side MCP tools (PR context)

Goal: an agent can inspect a PR before deciding what to say.

- [x] `bitbucket_list_pull_requests` — filter by repo, state, BBQL query
- [x] `bitbucket_get_pull_request` — full PR metadata, reviewers, participants, approval state
- [x] `bitbucket_get_pull_request_diff` — unified diff text, byte-budgeted truncation (250 KB default)
- [x] `bitbucket_get_pull_request_diffstat` — per-file change summary with totals
- [x] `bitbucket_list_pull_request_comments` — paginated, includes inline anchors and `parent_id` for threading
- [x] `bitbucket_list_pull_request_statuses` — build/CI statuses with per-state counts and a rolled-up `overall_state`
- [x] `bitbucket_get_pipeline_failures` — failing test cases and sanitized log tail for each failed step of a Bitbucket Pipelines build (needs the `pipeline` scope)
- [x] Optional scopes: login requests `pipeline` and retries without it if Bitbucket rejects the request; tools whose scope the token lacks are disabled (hidden from the client's tool list) rather than left to fail with a 403
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

## Phase 5 — Open a PR

Goal: an agent can open a pull request for work it just finished, not
only comment on existing ones. See §3 of
[docs/bitbucket-api.md](docs/bitbucket-api.md) for the endpoint shape.

- [x] `bitbucket_create_pull_request` — source branch, destination branch,
  title, optional description, optional `draft` flag.
  - **Draft by default.** `draft` defaults to `true`; publishing takes an
    explicit `draft: false`. Realistic failure mode is "agent opens a
    half-baked PR that pings five humans"; the extra deliberation to
    publish is cheap. The result echoes the `draft` value Bitbucket
    stored, so an agent can tell if the flag was ignored. Behavior on
    plans without draft support is still unverified against the live
    API.
  - **Same-repo only.** Source is always a branch in the repo named in
    the path. No `source.repository` field, so a compromised agent can't
    open a fork → main PR to trigger privileged CI.
  - **Minimal schema.** `close_source_branch`, reviewers, and other
    payload knobs are not exposed yet — add fields when an agent
    actually needs them. Reviewers in particular would need an
    account-id resolution path (display name isn't accepted).
  - **No merge, no approve.** The token already carries
    `pullrequest:write`, which permits both; we deliberately don't
    expose tools for them. Under `authorization_code` mode an approve
    tool would let an agent self-approve under the user's identity,
    silently satisfying a reviewer requirement.
  - Operator gate is the existing `--allow-writes` flag; no new permission
    surface. See `pullrequest:write` note in
    [docs/bitbucket-api.md](docs/bitbucket-api.md) §1.

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
3. ~~**Encryption — non-Windows platforms.** Windows uses DPAPI (resolved). For macOS and Linux, what's the fallback?~~ **Resolved: option (a), OS keychains — without the native-module cost.** macOS uses the bundled `security` CLI, Linux uses `secret-tool` (libsecret), both driven as subprocesses, matching the DPAPI-via-PowerShell pattern. The Linux-on-headless-server edge case is handled by falling back to env-var credentials rather than a passphrase flow.
4. ~~**Diff size cap** — default max diff size before forcing the agent to fetch diffstat?~~ **Resolved: 250 KB default, 2 MB hard ceiling.** Configurable per call via the `max_bytes` argument on `bitbucket_get_pull_request_diff`; UTF-8-safe truncation with an explicit marker pointing at the diffstat tool.
5. ~~**Inline comment line semantics** — expose raw `to`/`from` or simplify?~~ **Resolved: `(side: 'new'|'old', line: number)`.** The tool schema makes Bitbucket's "exactly one of to/from per comment" rule unrepresentable-as-invalid.
6. ~~**Write confirmation** — dry-run preview + `confirm: true`, or trust the agent once `--allow-writes` is on?~~ **Resolved: trust the agent once `--allow-writes` is on.** The startup flag is the operator-level gate; requiring a per-call confirmation on top would cripple agent autonomy. Operators who want a stricter policy can simply not pass `--allow-writes`.
