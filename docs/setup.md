# Setup guide — bitbucket-mcp

End-to-end walkthrough for getting the server running against your own
Bitbucket Cloud account. Target environment is Windows; macOS/Linux
token storage is not yet implemented (see [ROADMAP open
question #3](../ROADMAP.md)).

## 1. Register a Bitbucket OAuth consumer

This project uses **user-owned** OAuth consumers — you create one in your
workspace, and only you use it. Nothing is shared.

1. Open Bitbucket Cloud and go to: **Workspace settings → OAuth consumers → Add consumer**.
2. Fill in:
   - **Name**: anything, e.g. `bitbucket-mcp (local)`
   - **Callback URL**: `http://127.0.0.1/callback`
     *(The server binds to an ephemeral loopback port at runtime; the
     host path is what Bitbucket validates.)*
   - **This is a private consumer**: **unchecked** — we use PKCE, so we
     need a public client.
   - **Permissions**: check all of
     - Account → Read
     - Repositories → Read
     - Pull requests → Read, Write
3. Save. Copy the **Key** shown on the consumer row — this is your
   `clientId`. There is no secret because the consumer is public + PKCE.

## 2. Build the server

```powershell
git clone <this repo> bitbucket-mcp
cd bitbucket-mcp
npm install
npm run build
```

## 3. Configure your clientId

Either put it in `config.json` (see [`config.example.json`](../config.example.json))
or in an environment variable. The env var wins if both are set.

**Config file path:**
- Windows: `%APPDATA%\bitbucket-mcp\config.json`
- macOS: `~/Library/Application Support/bitbucket-mcp/config.json`
- Linux: `~/.config/bitbucket-mcp/config.json`

```json
{
  "clientId": "YOUR_CONSUMER_KEY",
  "defaultWorkspace": "your-workspace-slug"
}
```

**Or via env var:**

```powershell
$env:BITBUCKET_MCP_CLIENT_ID = "YOUR_CONSUMER_KEY"
$env:BITBUCKET_MCP_WORKSPACE = "your-workspace-slug"  # optional
```

## 4. Log in

```powershell
node dist/index.js login
```

This opens your browser to the Bitbucket authorize page. After you
consent, the server receives the code on the loopback port, exchanges
it for tokens, and persists them encrypted at rest via **Windows DPAPI**
(scoped to your Windows user account).

Verify:

```powershell
node dist/index.js whoami
# Logged in as Your Name ({xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}) ...
```

## 5. Wire into your MCP client

Point your MCP client at the built entry point. The exact config
format depends on the client, but the command+args pattern is:

- **Command:** `node`
- **Args:** `["C:\\absolute\\path\\to\\bitbucket-mcp\\dist\\index.js"]`
- For write access, append `"--allow-writes"` to args.
- Env: `BITBUCKET_MCP_CLIENT_ID`, optionally `BITBUCKET_MCP_WORKSPACE` if
  you didn't put them in `config.json`.

## 6. (Optional) Enable write tools

Read-side tools work without any extra flag. To allow the agent to post
comments, start the server with `--allow-writes`:

```powershell
node dist/index.js --allow-writes
```

Without this flag, `bitbucket_create_pr_comment`,
`bitbucket_reply_to_pr_comment`, and `bitbucket_create_pr_inline_comment`
refuse to run and return a single-line error explaining how to enable
them. This is an **operator-level** gate — orthogonal to whatever
scopes the token actually has.

## Troubleshooting

- **`whoami` says "No stored Bitbucket credentials"**: run `login` first.
- **Login browser page errors "Invalid redirect_uri"**: your OAuth
  consumer's callback URL is stricter than expected. Try setting it to
  exactly `http://127.0.0.1/callback` and retry.
- **Refresh fails after a long idle**: refresh tokens can be revoked
  server-side (e.g. if you revoked the OAuth consumer). Run `logout`
  then `login` again.
- **"Write tools are disabled"**: start the server with
  `--allow-writes`. This is intentional.
