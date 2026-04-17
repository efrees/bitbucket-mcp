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

- Runtime: TypeScript on Node.js 20+
- Transport: stdio only (no hosted HTTP server)
- Auth: Bitbucket Cloud OAuth 2.0 (3LO) with PKCE; user-owned OAuth consumer
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

## Things to watch out for

- **stdout is reserved for MCP framing.** All logging goes to stderr. Any
  stray `console.log` will corrupt the protocol.
- **Refresh tokens rotate** on every refresh — always persist the new one
  from the response, never reuse the old one.
- **Bitbucket pagination:** walk `next` URLs as-is; don't rebuild them.
- **Diffs can be huge.** The `/diff` endpoint returns text/plain and is
  unbounded — always apply a size cap before returning to an agent.
