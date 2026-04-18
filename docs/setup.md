# Setup guide — bitbucket-mcp

End-to-end walkthrough for getting the server running against your own
Bitbucket Cloud account. Target platform is Windows.

## 1. Register a Bitbucket OAuth consumer

1. In Bitbucket Cloud, go to **Workspace settings → OAuth consumers → Add consumer**.
2. Fill in:
   - **Name**: anything, e.g. `bitbucket-mcp (local)`
   - **Callback URL**: `http://127.0.0.1:33378/callback`
   - **This is a private consumer**: **checked** — you're the only
     one with this consumer's credentials, which is the case "private"
     describes. (Public would also work for the OAuth flow we use;
     the only real difference is that private additionally enables
     the `client_credentials` grant, which we don't invoke.)
   - **Permissions**: check Account → Read, Repositories → Read, and
     Pull requests → Read + Write
3. Save. Copy both the **Key** and the **Secret** shown on the consumer
   row — you'll need them in step 3 as `clientId` and `clientSecret`.

## 2. Build the server

```powershell
git clone <this repo> bitbucket-mcp
cd bitbucket-mcp
npm install
npm run build
```

## 3. Configure your credentials

Either put them in `config.json` (see [`config.example.json`](../config.example.json))
or set them as environment variables. Env vars win if both are set.

**Config file path (Windows):** `%APPDATA%\bitbucket-mcp\config.json`

```json
{
  "clientId": "YOUR_CONSUMER_KEY",
  "clientSecret": "YOUR_CONSUMER_SECRET",
  "defaultWorkspace": "your-workspace-slug"
}
```

**Or via env vars:**

```powershell
$env:BITBUCKET_MCP_CLIENT_ID = "YOUR_CONSUMER_KEY"
$env:BITBUCKET_MCP_CLIENT_SECRET = "YOUR_CONSUMER_SECRET"
$env:BITBUCKET_MCP_WORKSPACE = "your-workspace-slug"  # optional
```

## 4. Log in

```powershell
node dist/index.js login
```

Your browser opens the Bitbucket consent page. After you approve, the
CLI exchanges the code for tokens and stores them encrypted via
**Windows DPAPI** (scoped to your Windows user account).

Verify:

```powershell
node dist/index.js whoami
```

## 5. Wire into your MCP client

Point your MCP client at the built entry point:

- **Command:** `node`
- **Args:** `["C:\\absolute\\path\\to\\bitbucket-mcp\\dist\\index.js"]`
  (append `"--allow-writes"` to enable the comment-posting tools)
- **Env:** `BITBUCKET_MCP_CLIENT_ID`, optionally `BITBUCKET_MCP_WORKSPACE`

Read-only tools run by default. Write tools (`bitbucket_create_pr_comment`,
`bitbucket_reply_to_pr_comment`, `bitbucket_create_pr_inline_comment`)
require `--allow-writes` at startup.

## Troubleshooting

- **`whoami` says "No stored Bitbucket credentials"** — run `login` first.

- **Login errors with `unsupported_response_type`** — the OAuth consumer
  on Bitbucket is misconfigured. Re-check step 1: the callback URL is
  exactly `http://127.0.0.1:33378/callback`, all three permission rows
  are checked. Save the consumer again.

- **Token exchange fails with `unauthorized_client — Client credentials
  missing`** — `clientSecret` is not configured. Copy the Secret shown
  on the consumer row and set it in `config.json` or as
  `BITBUCKET_MCP_CLIENT_SECRET`.

- **`listen EADDRINUSE` or `listen EACCES` on 127.0.0.1:33378** —
  another process holds the port, or the port is in a Windows
  Hyper-V / WSL / Docker reserved range. Check reservations:

  ```powershell
  netsh interface ipv4 show excludedportrange protocol=tcp
  ```

  Pick a free port that isn't listed, then set both sides:
  `$env:BITBUCKET_MCP_CALLBACK_PORT = "<port>"` and update the
  consumer's callback URL to match.

- **Refresh fails after a long idle** — refresh tokens can be revoked
  (e.g. if you deleted the OAuth consumer). Run `logout` then `login`.

- **"Write tools are disabled"** — start the server with `--allow-writes`.
