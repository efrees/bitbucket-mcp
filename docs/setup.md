# Setup guide — bitbucket-mcp

End-to-end walkthrough for getting the server running against your own
Bitbucket Cloud account. Windows, macOS, and Linux are supported; shell
examples are PowerShell — translate paths and env-var syntax for your
shell as needed.

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
     Pull requests → Read + Write. Optionally also check Pipelines →
     Read, which `bitbucket_get_pipeline_failures` needs to read build
     logs and test reports. Without it everything else still works and
     that tool is simply not offered to the agent.
3. Save. Copy both the **Key** and the **Secret** shown on the consumer
   row.

## 2. Build the server

```powershell
git clone <this repo> bitbucket-mcp
cd bitbucket-mcp
npm install
npm run build
```

## 3. Configure the server

Non-secret settings go in `config.json` (see
[`config.example.json`](../config.example.json)) or environment
variables. Env vars win if both are set.

**Config file paths:**

- Windows: `%APPDATA%\bitbucket-mcp\config.json`
- macOS: `~/Library/Application Support/bitbucket-mcp/config.json`
- Linux: `~/.config/bitbucket-mcp/config.json`

```json
{
  "authMode": "client_credentials",
  "clientId": "YOUR_CONSUMER_KEY",
  "defaultWorkspace": "your-workspace-slug"
}
```

**Or via env vars:**

```powershell
$env:BITBUCKET_MCP_AUTH_MODE = "client_credentials"   # or authorization_code
$env:BITBUCKET_MCP_CLIENT_ID = "YOUR_CONSUMER_KEY"
$env:BITBUCKET_MCP_WORKSPACE = "your-workspace-slug"  # optional
```

## 4. Store the consumer secret

The consumer **Secret** is a live credential — anyone holding it can
mint workspace-scoped tokens — so it doesn't belong in a plaintext
file. Store it in your OS's secret store:

```powershell
node dist/index.js set-secret
```

You'll be prompted to paste the Secret (input is hidden). It's stored
via **DPAPI** on Windows, the login **Keychain** on macOS, or the
**Secret Service** (GNOME Keyring / KWallet) on Linux. Non-interactive
setups can pipe it instead: `echo $SECRET | node dist/index.js set-secret`.

Alternatively, set the `BITBUCKET_MCP_CLIENT_SECRET` environment
variable — this always takes precedence over the stored copy, and is
the right choice for CI or headless Linux machines without a keyring
daemon. Use `clear-secret` to remove a stored secret.

> A plaintext `clientSecret` field in `config.json` still works for
> backward compatibility, but logs a deprecation warning at startup.
> Move it into the secret store and delete it from the file.

## 5. (authorization_code mode only) Log in

Skip this step if you picked `client_credentials`.

```powershell
node dist/index.js login
```

Your browser opens the Bitbucket consent page. After you approve, the
CLI exchanges the code for tokens and stores them in your OS's secret
store: **DPAPI** on Windows (scoped to your Windows user account), the
login **Keychain** on macOS, or the **Secret Service** (GNOME Keyring /
KWallet, via `secret-tool`) on Linux.

Login asks for the optional Pipelines permission along with the
required ones. If your consumer doesn't have Pipelines → Read,
Bitbucket rejects that first request and login retries without it, so
you'll see a second browser tab open. To pick up a permission you add
to the consumer later, log in again.

> **Linux note:** the Secret Service backend needs `secret-tool`
> (Debian/Ubuntu: `apt install libsecret-tools`) and a running keyring
> daemon. Headless machines without one should use `client_credentials`
> mode, which never persists tokens to disk.

Once the server is wired into an MCP client (step 7), you can also log
in without a terminal: ask the agent to call the **`bitbucket_login`**
tool, which opens the same browser consent flow and stores the tokens.
MCP clients' built-in OAuth menus (like Claude Code's `/mcp` →
Reauthenticate) only apply to remote HTTP servers, so this tool is the
in-client equivalent for a local stdio server.

## 6. Verify

```powershell
node dist/index.js whoami
```

In `client_credentials` mode this fetches a token and confirms your
credentials work. In `authorization_code` mode it prints the Bitbucket
user you logged in as.

## 7. Wire into your MCP client

Point your MCP client at the built entry point:

- **Command:** `node`
- **Args:** `["C:\\absolute\\path\\to\\bitbucket-mcp\\dist\\index.js"]`
  (append `"--allow-writes"` to enable the comment-posting tools)
- **Env:** only what you didn't put in `config.json` / the secret
  store — typically nothing. Available: `BITBUCKET_MCP_CLIENT_ID`,
  `BITBUCKET_MCP_CLIENT_SECRET` (if not using `set-secret`),
  `BITBUCKET_MCP_AUTH_MODE`, `BITBUCKET_MCP_WORKSPACE`

Read-only tools run by default. Write tools (`bitbucket_create_pr_comment`,
`bitbucket_reply_to_pr_comment`, `bitbucket_create_pr_inline_comment`)
require `--allow-writes` at startup.

## Troubleshooting

- **`whoami` says "No stored Bitbucket credentials"** — you're in
  `authorization_code` mode and haven't logged in yet. Run `login`, or
  switch to `client_credentials` mode if you don't need user-attributed
  actions.

- **Token fetch fails with `unauthorized_client — Client credentials
  missing`** — the consumer secret is not set. Copy the Secret from
  your consumer and store it with `set-secret` (or set
  `BITBUCKET_MCP_CLIENT_SECRET`).

- **`set-secret` fails on Linux** — the Secret Service backend needs
  `secret-tool` (`apt install libsecret-tools`) and a running keyring
  daemon. On headless machines, use `BITBUCKET_MCP_CLIENT_SECRET`
  instead.

- **`unsupported_response_type`** (authorization_code mode only) — the
  OAuth consumer is misconfigured. Re-check step 1: callback URL is
  exactly `http://127.0.0.1:33378/callback`, all three required
  permission rows are checked. Save the consumer again.

- **`bitbucket_get_pipeline_failures` is missing from the tool list** —
  the token doesn't carry the `pipeline` scope. Check Pipelines → Read
  on the consumer (step 1), then restart the server
  (`client_credentials` mode) or log in again (`authorization_code`
  mode).

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
  refresh tokens can be revoked. Run `logout` then `login`, or ask the
  agent to call the `bitbucket_login` tool.

- **"Write tools are disabled"** — start the server with `--allow-writes`.
