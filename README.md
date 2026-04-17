# bitbucket-mcp

An [MCP](https://modelcontextprotocol.io) server that gives autonomous agents
the ability to read pull request context and reply to PR comments on
**Bitbucket Cloud**. Intended use cases:

- Agents performing autonomous code review on a teammate's PR.
- Agents acting on reviewer feedback left on the agent's own PR.

Status: **Phase 3 feature-complete on Windows.** OAuth login + five read
tools + three write tools are in place. See [ROADMAP.md](ROADMAP.md) for
remaining hardening work and [docs/bitbucket-api.md](docs/bitbucket-api.md)
for the Bitbucket API surface this project depends on.

Available MCP tools:

| Tool | Purpose |
|---|---|
| `bitbucket_list_pull_requests` | List PRs by repo/state/BBQL query |
| `bitbucket_get_pull_request` | Full PR metadata, reviewers, approval state |
| `bitbucket_get_pull_request_diff` | Unified diff text (byte-capped) |
| `bitbucket_get_pull_request_diffstat` | Per-file change summary |
| `bitbucket_list_pull_request_comments` | Flat comment list with inline anchors and `parent_id` |
| `bitbucket_create_pr_comment` | Post a top-level PR comment *(write — requires `--allow-writes`)* |
| `bitbucket_reply_to_pr_comment` | Reply to an existing comment *(write — requires `--allow-writes`)* |
| `bitbucket_create_pr_inline_comment` | Line-anchored review comment *(write — requires `--allow-writes`)* |

## Architecture at a glance

- **Transport:** local `stdio` MCP server, run on each user's machine.
- **Auth:** Bitbucket Cloud OAuth 2.0 (3LO) with PKCE — every action is
  attributed to the human user who logged in.
- **OAuth consumer:** user-owned. Each user registers an OAuth consumer in
  their Bitbucket workspace and supplies its `client_id`.
- **Token storage:** encrypted file under the user's config directory.

## Quick start (forward-looking — not all wired up yet)

Distributed git-only for now — install from source:

```bash
git clone <this repo> bitbucket-mcp
cd bitbucket-mcp
npm install
npm run build

# One-time login
node dist/index.js login

# Confirm identity
node dist/index.js whoami

# Run as an MCP server over stdio (read-only by default)
node dist/index.js

# Enable write tools (posting comments)
node dist/index.js --allow-writes
```

Wire `node /absolute/path/to/dist/index.js` into your MCP client config as a
stdio server. Set the env vars `BITBUCKET_MCP_CLIENT_ID` and (optionally)
`BITBUCKET_MCP_WORKSPACE` so they're visible when the client spawns the
process.

## Repo layout

```
bitbucket-mcp/
├── CLAUDE.md              # guidance for Claude Code sessions
├── ROADMAP.md             # phases and open questions
├── docs/
│   └── bitbucket-api.md   # API surface & OAuth flow we depend on
├── src/
│   ├── index.ts           # CLI entry point (login/logout/whoami/serve)
│   ├── server.ts          # MCP server factory + startStdioServer
│   ├── config.ts          # config loader
│   ├── logger.ts          # stderr-only structured logger
│   ├── errors.ts          # BitbucketApiError / AuthError / ConfigError
│   ├── paths.ts           # OS-specific config/token paths
│   ├── cli/               # CLI subcommand handlers
│   ├── auth/              # OAuth PKCE, DPAPI token store, AuthSession
│   ├── bitbucket/         # HTTP client, pagination, API types
│   └── tools/             # MCP tool registrations (one file per tool)
├── package.json
└── tsconfig.json
```

## Contributing

This is an early-stage personal project. Open questions and direction live in
[ROADMAP.md](ROADMAP.md).
