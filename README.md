# bitbucket-mcp

> **Check the official server first.** The
> [Atlassian MCP Server](https://developer.atlassian.com/cloud/rovo-mcp/)
> (also called the Rovo MCP Server)
> [supports Bitbucket Cloud](https://www.atlassian.com/blog/bitbucket/the-atlassian-rovo-mcp-server-now-supports-bitbucket-cloud)
> for workspaces linked to an Atlassian organization, including reading,
> creating and commenting on pull requests and reading pipeline logs.
> Paid team workspaces
> [are now linked](https://support.atlassian.com/bitbucket-cloud/kb/linking-your-bitbucket-cloud-workspace-to-an-atlassian-organization/),
> so for most teams that's the place to start.
>
> This project is for setups where it doesn't fit: your org admin hasn't
> enabled the Rovo MCP Server or the auth its Bitbucket tools need, your
> workspace isn't linked, or you want a local stdio server that runs on
> your own OAuth consumer and refuses writes unless started with
> `--allow-writes`.

An [MCP](https://modelcontextprotocol.io) server that gives autonomous agents
the ability to read pull request context, reply to PR comments, and open
pull requests on **Bitbucket Cloud**. Intended use cases:

- Agents performing autonomous code review on a teammate's PR.
- Agents acting on reviewer feedback left on the agent's own PR.
- Agents opening a (draft) PR for work they just finished.

Status: **Phases 3 and 5 feature-complete** on Windows, macOS, and Linux. OAuth
(both modes) + seven read tools + four write tools are in place. See
[ROADMAP.md](ROADMAP.md) for remaining hardening work and
[docs/bitbucket-api.md](docs/bitbucket-api.md) for the Bitbucket API
surface this project depends on.

Available MCP tools:

| Tool | Purpose |
|---|---|
| `bitbucket_list_pull_requests` | List PRs by repo/state/BBQL query |
| `bitbucket_get_pull_request` | Full PR metadata, reviewers, approval state |
| `bitbucket_get_pull_request_diff` | Unified diff text (byte-capped) |
| `bitbucket_get_pull_request_diffstat` | Per-file change summary |
| `bitbucket_list_pull_request_comments` | Flat comment list with inline anchors, `parent_id`, and draft (`pending`) state |
| `bitbucket_list_pull_request_statuses` | Build/CI statuses with a rolled-up overall state |
| `bitbucket_get_pipeline_failures` | Failing tests and sanitized log tail for a failed Bitbucket Pipelines build *(only offered when the consumer has Pipelines: Read)* |
| `bitbucket_create_pr_comment` | Post a top-level PR comment, optionally as a draft *(write — requires `--allow-writes`)* |
| `bitbucket_reply_to_pr_comment` | Reply to an existing comment, optionally as a draft *(write — requires `--allow-writes`)* |
| `bitbucket_create_pr_inline_comment` | Line-anchored review comment on one line or a range (`start_line`), optionally as a draft *(write — requires `--allow-writes`)* |

The three comment tools take an optional `pending: true` (default
`false`) that posts the comment as a draft only you can see. Publish
your drafts with **Finish Review** on the pull request in Bitbucket.
Drafts need `authorization_code` mode, because in `client_credentials`
mode there is no one who can sign in to publish them.
| `bitbucket_create_pull_request` | Open a same-repo PR, draft by default *(write — requires `--allow-writes`)* |

## Architecture at a glance

- **Transport:** local `stdio` MCP server, run on each user's machine.
- **Auth:** Bitbucket Cloud OAuth 2.0 against a user-owned **private**
  OAuth consumer. Two modes, selected by `authMode`:

  | Mode | Flow | Actions attributed to |
  |---|---|---|
  | `client_credentials` *(default)* | Headless; no browser step, no stored tokens | The OAuth consumer (bot) |
  | `authorization_code` | Browser consent once; refresh token persisted | Your Bitbucket user |

- **Secret storage:** the consumer secret and any OAuth tokens live in the
  OS-native vault — Windows DPAPI, macOS Keychain, Linux Secret Service —
  never in plaintext config.

## Quick start

For a complete step-by-step walkthrough (OAuth consumer registration,
config file paths, MCP client wiring), see [docs/setup.md](docs/setup.md).
The example below uses `authorization_code` mode so agent actions show up
under your own name; swap `authMode` to `client_credentials` and skip the
`login` step for a headless, bot-attributed setup.

1. Register a private OAuth consumer in Bitbucket with callback URL
   `http://127.0.0.1:33378/callback` and permissions Account: Read,
   Repositories: Read, Pull requests: Read + Write (plus, optionally,
   Pipelines: Read for build-failure details). Copy its Key and Secret.

2. Build from source (git-only distribution for now):

   ```bash
   git clone <this repo> bitbucket-mcp
   cd bitbucket-mcp
   npm install
   npm run build
   ```

3. Create `config.json` (Windows: `%APPDATA%\bitbucket-mcp\config.json`;
   see [config.example.json](config.example.json) for other OS paths):

   ```json
   {
     "authMode": "authorization_code",
     "clientId": "YOUR_CONSUMER_KEY",
     "defaultWorkspace": "your-workspace-slug"
   }
   ```

4. Store the secret, log in, and verify:

   ```bash
   node dist/index.js set-secret   # prompts for the consumer Secret
   node dist/index.js login        # opens the browser consent page
   node dist/index.js whoami       # prints the Bitbucket user you logged in as
   ```

5. Wire it into your MCP client. For Claude Code:

   ```bash
   claude mcp add --scope user bitbucket -- node /absolute/path/to/bitbucket-mcp/dist/index.js --allow-writes
   ```

   Or in a project's `.mcp.json`:

   ```json
   {
     "mcpServers": {
       "bitbucket": {
         "command": "node",
         "args": ["/absolute/path/to/bitbucket-mcp/dist/index.js", "--allow-writes"]
       }
     }
   }
   ```

   Drop `--allow-writes` to expose only the read tools. Anything not in
   `config.json` can be supplied as env vars (`BITBUCKET_MCP_AUTH_MODE`,
   `BITBUCKET_MCP_CLIENT_ID`, `BITBUCKET_MCP_CLIENT_SECRET`,
   `BITBUCKET_MCP_WORKSPACE`); env vars win over the file.

If a token later expires or is revoked, ask the agent to call the
`bitbucket_login` tool — it runs the same browser flow in-process. (Claude
Code's `/mcp` Authenticate menu only applies to remote HTTP servers.)

## Repo layout

```
bitbucket-mcp/
├── CLAUDE.md              # guidance for Claude Code sessions
├── ROADMAP.md             # phases and open questions
├── config.example.json    # annotated config template
├── docs/
│   ├── setup.md           # end-to-end setup guide
│   └── bitbucket-api.md   # API surface & OAuth flow we depend on
├── src/
│   ├── index.ts           # CLI entry point (login/logout/whoami/set-secret/serve)
│   ├── server.ts          # MCP server factory + startStdioServer
│   ├── config.ts          # config loader
│   ├── logger.ts          # stderr-only structured logger
│   ├── errors.ts          # BitbucketApiError / AuthError / ConfigError
│   ├── paths.ts           # OS-specific config/token paths
│   ├── cli/               # CLI subcommand handlers
│   ├── auth/              # OAuth flows, SecretVault backends, token store
│   ├── bitbucket/         # HTTP client, pagination, API types
│   └── tools/             # MCP tool registrations (one file per tool)
├── package.json
└── tsconfig.json
```

## Contributing

This is an early-stage personal project. Open questions and direction live in
[ROADMAP.md](ROADMAP.md).
