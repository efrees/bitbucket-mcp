# Setup guide — bitbucket-mcp

End-to-end walkthrough for getting the server running against your own
Bitbucket Cloud account. Target platform is Windows.

## Pick an auth mode

| Mode | When to pick it | How actions appear on PRs |
|---|---|---|
| `client_credentials` *(default)* | You want a headless setup with no browser step; agent comments are clearly labelled as automation. | Authored by the OAuth consumer (the name you gave it). |
| `authorization_code` | You want agent actions attributed to your Bitbucket user account. | Authored by you personally. |

Both modes use the same OAuth consumer and the same `clientId` +
`clientSecret` config. Only the runtime flow differs.

## 1. Register a Bitbucket OAuth consumer

1. In Bitbucket Cloud, go to **Workspace settings → OAuth consumers → Add consumer**.
2. Fill in:
   - **Name**: anything, e.g. `bitbucket-mcp (local)`
   - **Callback URL**: `http://127.0.0.1:33378/callback`
     *(only used in `authorization_code` mode, but the field is
     required to register the consumer)*
   - **This is a private consumer**: **checked** — you're the only
     one with this consumer's credentials.
   - **Permissions**: check Account → Read, Repositories → Read, and
     Pull requests → Read + Write
3. Save. Copy both the **Key** and the **Secret** shown on the consumer
   row.

## 2. Build the server

```powershell
git clone <this repo> bitbucket-mcp
cd bitbucket-mcp
npm install
npm run build
```

## 3. Configure credentials

Either put them in `config.json` (see [`config.example.json`](../config.example.json))
or set them as environment variables. Env vars win if both are set.

**Config file path (Windows):** `%APPDATA%\bitbucket-mcp\config.json`

```json
{
  "authMode": "client_credentials",
  "clientId": "YOUR_CONSUMER_KEY",
  "clientSecret": "YOUR_CONSUMER_SECRET",
  "defaultWorkspace": "your-workspace-slug"
}
```

**Or via env vars:**

```powershell
$env:BITBUCKET_MCP_AUTH_MODE   = "client_credentials"   # or authorization_code
$env:BITBUCKET_MCP_CLIENT_ID   = "YOUR_CONSUMER_KEY"
$env:BITBUCKET_MCP_CLIENT_SECRET = "YOUR_CONSUMER_SECRET"
$env:BITBUCKET_MCP_WORKSPACE   = "your-workspace-slug"  # optional
```

## 4. (authorization_code mode only) Log in

Skip this step if you picked `client_credentials`.

```powershell
node dist/index.js login
```

Your browser opens the Bitbucket consent page. After you approve, the
CLI exchanges the code for tokens and stores them encrypted via
**Windows DPAPI** (scoped to your Windows user account).

## 5. Verify

```powershell
node dist/index.js whoami
```

In `client_credentials` mode this fetches a token and confirms your
credentials work. In `authorization_code` mode it prints the Bitbucket
user you logged in as.

## 6. Wire into your MCP client

Point your MCP client at the built entry point:

- **Command:** `node`
- **Args:** `["C:\\absolute\\path\\to\\bitbucket-mcp\\dist\\index.js"]`
  (append `"--allow-writes"` to enable the comment-posting tools)
- **Env:** `BITBUCKET_MCP_CLIENT_ID`, `BITBUCKET_MCP_CLIENT_SECRET`,
  `BITBUCKET_MCP_AUTH_MODE` (if not `client_credentials`),
  optionally `BITBUCKET_MCP_WORKSPACE`

Read-only tools run by default. Write tools (`bitbucket_create_pr_comment`,
`bitbucket_reply_to_pr_comment`, `bitbucket_create_pr_inline_comment`)
require `--allow-writes` at startup.

## Troubleshooting

- **`whoami` says "No stored Bitbucket credentials"** — you're in
  `authorization_code` mode and haven't logged in yet. Run `login`, or
  switch to `client_credentials` mode if you don't need user-attributed
  actions.

- **Token fetch fails with `unauthorized_client — Client credentials
  missing`** — `clientSecret` is not set. Copy the Secret from your
  consumer and set it via config.json or `BITBUCKET_MCP_CLIENT_SECRET`.

- **`unsupported_response_type`** (authorization_code mode only) — the
  OAuth consumer is misconfigured. Re-check step 1: callback URL is
  exactly `http://127.0.0.1:33378/callback`, all three permission rows
  are checked. Save the consumer again.

- **`listen EADDRINUSE` or `listen EACCES` on 127.0.0.1:33378**
  (authorization_code mode only) — another process holds the port, or
  the port is in a Windows Hyper-V / WSL / Docker reserved range:

  ```powershell
  netsh interface ipv4 show excludedportrange protocol=tcp
  ```

  Pick a free port that isn't listed, then set both sides:
  `$env:BITBUCKET_MCP_CALLBACK_PORT = "<port>"` and update the
  consumer's callback URL to match.

- **Refresh fails after a long idle** (authorization_code mode only) —
  refresh tokens can be revoked. Run `logout` then `login`.

- **"Write tools are disabled"** — start the server with `--allow-writes`.
