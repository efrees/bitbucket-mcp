# bitbucket-mcp

An [MCP](https://modelcontextprotocol.io) server that gives autonomous agents
the ability to read pull request context and reply to PR comments on
**Bitbucket Cloud**. Intended use cases:

- Agents performing autonomous code review on a teammate's PR.
- Agents acting on reviewer feedback left on the agent's own PR.

Status: **bootstrap** — see [ROADMAP.md](ROADMAP.md) for what's planned and
[docs/bitbucket-api.md](docs/bitbucket-api.md) for the Bitbucket API surface
this project depends on.

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

# One-time login (Phase 1 — not yet implemented)
node dist/index.js login

# Run as an MCP server over stdio
node dist/index.js
```

Wire `node /absolute/path/to/dist/index.js` into your MCP client config as a
stdio server.

## Repo layout

```
bitbucket-mcp/
├── ROADMAP.md             # phases and open questions
├── docs/
│   └── bitbucket-api.md   # API surface & OAuth flow we depend on
├── src/
│   ├── index.ts           # stdio entry point
│   └── server.ts          # MCP server + tool registration (currently empty)
├── package.json
└── tsconfig.json
```

## Contributing

This is an early-stage personal project. Open questions and direction live in
[ROADMAP.md](ROADMAP.md).
