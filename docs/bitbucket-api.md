# Bitbucket Cloud API — Surface We Depend On

This is a reference for the subset of the Bitbucket Cloud REST API and OAuth
flow that this MCP server uses. It is **not** a substitute for the official
docs; it captures the shape of the calls and the gotchas we've already designed
around.

Authoritative sources:
- REST API 2.0: <https://developer.atlassian.com/cloud/bitbucket/rest/intro/>
- OAuth 2.0: <https://support.atlassian.com/bitbucket-cloud/docs/use-oauth-on-bitbucket-cloud/>

API base URL: `https://api.bitbucket.org/2.0`

---

## 1. Authentication — OAuth 2.0 (3LO) with PKCE

We use the authorization-code flow with PKCE so that a public client (a CLI
running on the user's machine) can authenticate without shipping a client
secret.

### Endpoints

| Step | URL |
|---|---|
| Authorize | `https://bitbucket.org/site/oauth2/authorize` |
| Token exchange / refresh | `https://bitbucket.org/site/oauth2/access_token` |

### Per-user OAuth consumer setup

Each user creates an OAuth consumer in their own Bitbucket workspace:

> Workspace settings → **OAuth consumers** → **Add consumer**

Required fields:
- **Name**: e.g. `bitbucket-mcp (local)`
- **Callback URL**: `http://localhost:0/callback` is acceptable for setup; the
  server will request the actual ephemeral port at login time. Bitbucket
  validates only the host/path on registered callbacks, so you can register
  `http://127.0.0.1/callback` and we'll bind to a free port at runtime.
  *(See open question #2 below — confirm this matches current Bitbucket
  behavior at implementation time.)*
- **This is a private consumer**: leave **unchecked** (we want PKCE / public
  client behavior).
- **Permissions** (scopes): see scopes table below.

The user copies the **Key** (this is the `client_id`) into our config file.
There is no `client_secret` to paste because we use PKCE.

### Authorization request

```
GET https://bitbucket.org/site/oauth2/authorize
  ?client_id=<consumer key>
  &response_type=code
  &state=<random opaque>
  &code_challenge=<base64url(sha256(verifier))>
  &code_challenge_method=S256
  &redirect_uri=http://127.0.0.1:<ephemeral_port>/callback
```

User consents in the browser; Bitbucket redirects to the loopback callback
with `?code=...&state=...`.

### Token exchange

```
POST https://bitbucket.org/site/oauth2/access_token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<received code>
&code_verifier=<original verifier>
&client_id=<consumer key>
&redirect_uri=http://127.0.0.1:<ephemeral_port>/callback
```

Response:

```json
{
  "access_token": "...",
  "scopes": "account pullrequest pullrequest:write repository",
  "expires_in": 7200,
  "refresh_token": "...",
  "token_type": "bearer"
}
```

`access_token` lifetime is 2 hours. `refresh_token` is long-lived and rotates
on each refresh — **always persist the new refresh token returned by a refresh
call**.

### Refresh

```
POST https://bitbucket.org/site/oauth2/access_token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=<current>
&client_id=<consumer key>
```

### Scopes we request

| Scope | Why |
|---|---|
| `account` | Identify the authenticated user (`/user`) for `whoami` and audit logging |
| `repository` | Read repo metadata, diffs, diffstats |
| `pullrequest` | Read PRs and PR comments |
| `pullrequest:write` | Reply to comments, create inline comments |

Scopes implicitly include weaker variants (e.g. `repository:write` would imply
`repository`), but we never request write on `repository` itself — only on
`pullrequest`.

### Authenticated request shape

All API calls send:

```
Authorization: Bearer <access_token>
Accept: application/json
```

---

## 2. Pagination

Most list endpoints return a paged envelope:

```json
{
  "pagelen": 50,
  "size": 137,
  "page": 1,
  "next": "https://api.bitbucket.org/2.0/.../pullrequests?page=2",
  "values": [ ... ]
}
```

Rules we follow:
- Pass `pagelen=50` (max for most endpoints is 100; 50 is a safer default).
- Walk `next` URLs as-is — do **not** rebuild query strings.
- Cap at a configurable max page count to avoid runaway pagination on huge
  repos.

---

## 3. Pull request endpoints

### List PRs

```
GET /repositories/{workspace}/{repo_slug}/pullrequests
  ?state=OPEN|MERGED|DECLINED|SUPERSEDED  (repeatable)
  &q=<BBQL filter>
  &fields=...
  &pagelen=50
```

Useful BBQL filters: `author.uuid="{...}"`, `reviewers.uuid="{...}"`,
`source.branch.name="feat/x"`.

### Get a single PR

```
GET /repositories/{workspace}/{repo_slug}/pullrequests/{pull_request_id}
```

Key fields we surface to agents: `id`, `title`, `description`, `state`,
`source.branch.name`, `destination.branch.name`, `author`, `reviewers`,
`participants`, `links.html.href`, `created_on`, `updated_on`.

### Get the diff

```
GET /repositories/{workspace}/{repo_slug}/pullrequests/{pull_request_id}/diff
Accept: text/plain
```

Returns a **unified diff as text**, not JSON. Can be very large — we'll
truncate with a configurable cap and tell the agent to fall back to diffstat.

### Get diffstat (lighter weight)

```
GET /repositories/{workspace}/{repo_slug}/pullrequests/{pull_request_id}/diffstat
```

JSON paged list of files changed with `lines_added`, `lines_removed`, and
`status` (`added` / `modified` / `removed` / `renamed`).

---

## 4. Comment endpoints

### List comments on a PR

```
GET /repositories/{workspace}/{repo_slug}/pullrequests/{pull_request_id}/comments
  ?pagelen=50
```

Each comment object includes:

```json
{
  "id": 12345,
  "content": { "raw": "...", "markup": "markdown", "html": "..." },
  "user": { "display_name": "...", "uuid": "{...}" },
  "created_on": "...",
  "updated_on": "...",
  "deleted": false,
  "parent": { "id": 12340 },          // present only for replies
  "inline": {                         // present only for inline comments
    "path": "src/foo.ts",
    "to":   42,                       // line number on the NEW side
    "from": null                      // line number on the OLD side
  },
  "pullrequest": { "id": 99 }
}
```

Threading is reconstructed client-side via `parent.id`.

### Create a top-level comment

```
POST /repositories/{workspace}/{repo_slug}/pullrequests/{pull_request_id}/comments
Content-Type: application/json

{
  "content": { "raw": "Looks good to me." }
}
```

### Reply to a comment

Same endpoint, with a `parent`:

```json
{
  "content": { "raw": "Agreed — pushed a fix in abc1234." },
  "parent":  { "id": 12345 }
}
```

### Create an inline (line-anchored) review comment

```json
{
  "content": { "raw": "This branch can `??` the previous expression." },
  "inline": {
    "path": "src/parser.ts",
    "to":   118
  }
}
```

Rules:
- Use `to` for a line on the **new** side of the diff (the version being
  proposed).
- Use `from` for a line on the **old** side (e.g. commenting on a removed
  line).
- Use exactly one of `to` or `from` per comment, not both.
- `path` must match the path as it appears in the diff (post-rename for
  renamed files — uses the new name).

---

## 5. Identity

```
GET /user
```

Returns the authenticated user's `uuid`, `display_name`, `username`
(deprecated but still present), and `account_id`. Used by `whoami` and to
attach the acting identity to logs.

---

## 6. Errors and rate limits

### Error envelope

```json
{
  "type": "error",
  "error": {
    "message": "Resource not found",
    "detail":  "...",
    "fields":  { "...": ["..."] }   // optional
  }
}
```

Our HTTP client maps these to `BitbucketApiError` with `status`, `code`, and
`message` carried through to the MCP tool error.

### Rate limits

- Per-hour quota per OAuth user (Atlassian publishes current numbers in their
  rate-limit doc — verify at implementation time; treat the response headers
  as authoritative).
- On `429` we honor `Retry-After` (seconds), with capped exponential backoff
  on transient `5xx`.

---

## Open questions — to verify against live API during Phase 1

1. Confirm Bitbucket Cloud OAuth still supports PKCE with `S256` for public
   consumers (it did at last writing — re-check before locking the flow).
2. Confirm the redirect URI matching rules for loopback consumers — specifically
   whether the registered callback can be a fixed `http://127.0.0.1/callback`
   while the runtime port varies. Atlassian's behavior here has shifted over
   the years; if it requires an exact match including port, we'll register a
   range or document a fixed port.
3. Confirm current scope strings — Atlassian has been migrating scope naming
   conventions (e.g. `repository:read` vs `repository`).
4. Capture a live `429` response in Phase 4 to confirm the `Retry-After`
   header is set rather than only documented.
