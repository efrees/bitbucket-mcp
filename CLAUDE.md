# CLAUDE.md

Guidance for Claude Code sessions working on this repo. Read this first.

## What this project is

A local-stdio **MCP server** that gives autonomous agents the ability to read
pull request context and reply to PR comments on **Bitbucket Cloud**.
Primary consumers are code-review agents and agents acting on reviewer
feedback. See [ROADMAP.md](ROADMAP.md) for phased plan and
[docs/bitbucket-api.md](docs/bitbucket-api.md) for the Bitbucket API surface.

## Commit conventions — atomic commits

**One logical change per commit.** If a commit description needs the word
"and" to describe what it does, it's probably two commits. Mechanical
refactors go in their own commit separate from behavior changes.

**Commit message format:**

```
Short imperative subject (≤ 72 chars, no trailing period)

Body paragraph explaining *why* this change exists and what problem it
solves. Wrap at ~72 columns. Skip restating the diff — the diff already
shows what changed; the message explains motivation and any non-obvious
trade-offs.

- Bullet points are fine when listing distinct facets of one change
- Reference ROADMAP phases or open questions when relevant (e.g. "Resolves
  open question #3")

Co-Authored-By: Claude <noreply@anthropic.com>
```

Rules of thumb:

- **Subject line is imperative mood** ("Add DPAPI token store", not "Added"
  or "Adds"). Think: "If applied, this commit will ___."
- **Always include a body** unless the change is truly trivial (typo,
  one-line config). The body is where motivation lives.
- **Each commit should build and typecheck on its own.** Don't split a
  change such that an intermediate commit is broken.
- **Don't mix bootstrap/scaffolding with feature work.** The initial scaffold
  commit is separate from Phase 1 login work, which is separate from Phase 2
  read tools, etc.
- **Resolve open questions explicitly.** When a ROADMAP open question gets
  answered, the commit that acts on it should say so in the body.

Always pass multiline commit messages via heredoc to preserve formatting —
don't inline `\n` in `-m` strings.

## Architectural decisions already locked

Don't re-litigate these without the user asking:

- Runtime: TypeScript on Node.js 22+ (needs `node --test` glob support, which landed in 21)
- Transport: stdio only (no hosted HTTP server)
- Auth: dual-mode. `client_credentials` grant (headless, bot-attributed actions, workspace-scoped token, no refresh token) is the default. `authorization_code` (3LO, user-attributed, browser consent, DPAPI-persisted refresh) is available via `authMode: "authorization_code"`. Both require `clientId` + `clientSecret` (HTTP Basic auth at the token endpoint). User-owned **private** OAuth consumer.
- Windows token storage: DPAPI (`CryptProtectData`, user scope)
- CI: GitHub Actions on `windows-latest`
- Distribution: git-only for now (no npm publish)

If the user asks to revisit one, fine — but start from "here's why we
originally chose X" rather than proposing alternatives cold.

## Where things live

```
.github/workflows/ci.yml   # typecheck + build on Windows
docs/bitbucket-api.md      # API surface we depend on; update when we add endpoints
ROADMAP.md                 # phased plan + open questions
src/index.ts               # stdio entry point
src/server.ts              # MCP server factory; tools registered here
```

When a new MCP tool is added, update both its module under `src/tools/` (once
that directory exists) *and* the relevant section of `docs/bitbucket-api.md`
if a new endpoint is being consumed.

## Docs stay current — or get deleted

Stale documentation is actively harmful here. The only thing worse than docs
that are too long is docs that are wrong. When working in this repo:

- **Update docs in the same commit as the code change that invalidates them.**
  If you rename a function referenced in [docs/bitbucket-api.md](docs/bitbucket-api.md), the rename and the doc
  edit are one atomic commit — not a TODO for later.
- **ROADMAP.md, CLAUDE.md, and docs/ are code.** Treat them with the same
  "keep it accurate" standard as `src/`. Open questions that get resolved
  should be struck through or moved, not left dangling.
- **Prefer deletion over stale content.** If a section isn't being kept
  current and isn't load-bearing, delete it. An accurate short doc beats a
  half-right long one.
- **If you notice drift, fix it immediately or flag it.** Drift compounds.

## Things to watch out for

- **stdout is reserved for MCP framing.** All logging goes to stderr. Any
  stray `console.log` will corrupt the protocol.
- **Refresh tokens rotate** on every refresh — always persist the new one
  from the response, never reuse the old one.
- **Bitbucket pagination:** walk `next` URLs as-is; don't rebuild them.
- **Diffs can be huge.** The `/diff` endpoint returns text/plain and is
  unbounded — always apply a size cap before returning to an agent.

## Hard-won specifics you should not re-derive

Concrete facts we've already paid to learn. Don't regress these without
strong new evidence:

- **OAuth callback port must be fixed, not ephemeral.** Bitbucket does
  exact matching on the registered callback URL including port. The
  default is `33378`; picking anything `≥ 49152` is unsafe on Windows
  because Hyper-V / WSL / Docker Desktop silently reserve large chunks of
  the dynamic range and `bind()` fails with `EACCES`. If you change the
  default, keep it below 49152.

- **Do NOT open URLs on Windows via `cmd /c start "" <url>`.** cmd.exe's
  parser splits on `&` even when the URL is a single argv element, so
  everything from the first `&` in the query string is discarded before
  `start` sees it. Use `rundll32.exe url.dll,FileProtocolHandler <url>`
  — that goes straight to ShellExecute with no shell interpretation.
  PowerShell `Start-Process` has also misbehaved under `detached: true`
  (the PS process exits before the hand-off completes).

- **Scopes are configured on the consumer, not requested in the
  authorize URL.** Bitbucket validates that any `scope=` in the request
  is a subset of what the consumer already has; sending scopes the
  consumer lacks causes the whole authorize call to fail with a
  misleading error (`unsupported_response_type — Invalid value specified
  None`). The safe path is to keep the request's `scope` aligned with
  the permissions selected when registering the consumer.

- **Bitbucket requires the client_secret at the token endpoint even
  with PKCE.** Sending `client_id` in the POST body (no Authorization
  header) gets `unauthorized_client — Client credentials missing`. The
  fix is HTTP Basic auth (`Authorization: Basic base64(id:secret)`) on
  both `authorization_code` and `refresh_token` grants. PKCE still
  rides along as defense-in-depth.

- **Public vs. private consumer is not about secrets.** Both kinds have
  a `clientSecret`. The "private" checkbox enables the
  `client_credentials` grant and signals that the credentials are held
  by the consumer's owner rather than distributed in a binary. For
  this project the consumer should be **private** — each user provisions
  their own, and the `client_credentials` mode literally needs the grant
  enabled.

- **PKCE on Bitbucket *Cloud* is cosmetic.** Bitbucket Server supports
  authorization_code + PKCE for public clients. Bitbucket *Cloud* does
  not: its token endpoint requires HTTP Basic auth with
  clientId:clientSecret regardless of any PKCE parameters on the
  authorize call. The authorize endpoint accepts code_challenge /
  code_challenge_method without complaining (unknown params are
  ignored), but Cloud never validates them. Our 3LO path still sends
  them as defense-in-depth for a future when this changes; don't
  mistake their presence for "we're doing PKCE" in the security-model
  sense.

- **`client_credentials` is a real OAuth grant type**, not a Bitbucket
  coinage — it's RFC 6749 §1.3.4. Bitbucket's "private consumer" note
  uses the term correctly.

- **Windows DPAPI via PowerShell subprocess, not a native node module.**
  Spawning `powershell.exe` with a short
  `System.Security.Cryptography.ProtectedData` script is ~100ms per op,
  which is fine for the rare token read/write cadence and avoids a
  native-module dependency that would otherwise need to compile on every
  user's machine.
