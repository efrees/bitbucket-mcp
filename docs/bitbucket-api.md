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

## 1. Authentication — OAuth 2.0

Two grant types against the same user-owned **private** OAuth consumer,
selected by `authMode`:

| `authMode` | Grant | Actions attributed to | Token lifetime |
|---|---|---|---|
| `client_credentials` *(default)* | Client credentials (RFC 6749 §4.4) | The consumer | In memory only; re-fetched on expiry |
| `authorization_code` | Authorization code (3LO), browser consent | The consenting user | Refresh token persisted in the OS vault |

Consumer registration is covered in [setup.md](setup.md).

### Endpoints

| Step | URL |
|---|---|
| Authorize (`authorization_code` only) | `https://bitbucket.org/site/oauth2/authorize` |
| Token (all grants) | `https://bitbucket.org/site/oauth2/access_token` |

Every call to the token endpoint authenticates the consumer with HTTP
Basic auth:

```
Authorization: Basic base64(<consumer key>:<consumer secret>)
```

Bitbucket Cloud requires this for all three grants below. Sending
`client_id` in the body instead is rejected with `unauthorized_client —
Client credentials missing`.

### Client credentials grant

```
POST https://bitbucket.org/site/oauth2/access_token
Authorization: Basic ...
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
```

Requires the consumer to be private. The response has the shape shown
under "Token exchange" below, minus `refresh_token`; when the access token
nears expiry we simply request another.

### Authorization request

```
GET https://bitbucket.org/site/oauth2/authorize
  ?client_id=<consumer key>
  &response_type=code
  &state=<random opaque>
  &scope=<space-separated scopes>
  &code_challenge=<base64url(sha256(verifier))>
  &code_challenge_method=S256
  &redirect_uri=http://127.0.0.1:33378/callback
```

- `redirect_uri` must match the consumer's registered callback URL exactly,
  **including the port**, so the loopback listener binds a fixed port
  (default `33378`, overridable via `BITBUCKET_MCP_CALLBACK_PORT`).
- `scope` must be a subset of the consumer's permissions. Naming a scope
  the consumer lacks fails the whole request with a misleading
  `unsupported_response_type`.
- The PKCE parameters are accepted but not validated by Bitbucket Cloud.
  We send them anyway; the consumer secret is what actually protects the
  exchange.

User consents in the browser; Bitbucket redirects to the loopback callback
with `?code=...&state=...`, or with `?error=...` on failure.

### Token exchange

```
POST https://bitbucket.org/site/oauth2/access_token
Authorization: Basic ...
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<received code>
&code_verifier=<original verifier>
&redirect_uri=http://127.0.0.1:33378/callback
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
Authorization: Basic ...
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=<current>
```

### Scopes we request

| Scope | Why |
|---|---|
| `account` | Identify the authenticated user (`/user`) at login |
| `repository` | Read repo metadata, diffs, diffstats |
| `pullrequest` | Read PRs and PR comments |
| `pullrequest:write` | Open PRs, reply to comments, create inline comments. (The same scope also permits merge, decline, and approve on any PR in the workspace; we deliberately do not expose tools for those.) |
| `pipeline` *(optional)* | Read Pipelines steps, logs, and test reports (§7) |

`pipeline` is optional. Bitbucket rejects an authorize request that names
a scope the consumer lacks, so `authorization_code` login asks for it on a
first attempt and, if that is rejected, retries with only the required
scopes. `client_credentials` tokens can't request scopes at all; they carry
whatever the consumer has. Either way the token response's `scopes` field
says what was granted, and tools that need a missing optional scope are
disabled.

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

### List build statuses

```
GET /repositories/{workspace}/{repo_slug}/pullrequests/{pull_request_id}/statuses
  ?pagelen=50
```

JSON paged list of the commit statuses (builds) reported against the PR —
Bitbucket Pipelines runs and anything third-party CI has posted. Covered by
the `pullrequest` scope. Each entry:

```json
{
  "type": "build",
  "key": "my-pipeline-42",            // reporter-chosen id, unique per commit
  "name": "Pipeline #42",
  "description": "...",
  "state": "SUCCESSFUL",              // SUCCESSFUL | FAILED | INPROGRESS | STOPPED
  "url": "https://...",               // link to the build in the CI system
  "refname": "feat/x",
  "created_on": "...",
  "updated_on": "..."
}
```

There is no server-side aggregate; `bitbucket_list_pull_request_statuses`
derives `overall_state` client-side, worst state first (`FAILED` > `STOPPED`
> `INPROGRESS` > `SUCCESSFUL`, `NONE` when the list is empty).

For Bitbucket Pipelines runs, `url` ends in the build number
(`.../pipelines/results/42`, or the older
`.../addon/pipelines/home#!/results/42`). We parse it out as
`pipeline_build_number`, the link into the Pipelines endpoints in §7.
Statuses from third-party CI point at that system and cannot be followed
with a Bitbucket token.

### Create a PR

```
POST /repositories/{workspace}/{repo_slug}/pullrequests
Content-Type: application/json

{
  "title":       "Fix flaky scheduler test",
  "description": "Optional raw Markdown.",
  "source":      { "branch": { "name": "fix/scheduler-flake" } },
  "destination": { "branch": { "name": "main" } },
  "draft":       true
}
```

Returns the newly created PR object (same shape as "Get a single PR"
above). Needs `pullrequest:write`.

Notes we rely on:
- The source branch is resolved in the repo named in the path; we never
  send a `source.repository` field, so cross-repo (fork) PRs are
  unrepresentable through this tool.
- The response's `draft` boolean is the only way to tell a draft from a
  published PR (both report `state: "OPEN"`). We return the stored
  value, not the requested one. Whether Bitbucket rejects or ignores
  `draft: true` on plans without draft support is unverified.
- `close_source_branch`, `reviewers`, and other optional payload fields
  are deliberately not exposed yet — add them to the tool schema when
  an agent actually needs them.

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
  "pending": false,                   // true for an unpublished draft (see below)
  "parent": { "id": 12340 },          // present only for replies
  "inline": {                         // present only for inline comments
    "path": "src/foo.ts",
    "to":   42,                       // line number on the NEW side
    "from": null,                     // line number on the OLD side
    "start_to":   null,               // first line of a multi-line range
    "start_from": null                //   (same side as to / from)
  },
  "pullrequest": { "id": 99 }
}
```

Threading is reconstructed client-side via `parent.id`.

Draft (`pending: true`) comments are returned only to their author,
interleaved with published ones. Other identities don't see them in the
list, and a direct `GET .../comments/{id}` returns 404 for them. The list
endpoint rejects `q=pending=true` with a 400, so drafts can't be
filtered server-side.

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

### Draft (pending) comments

Any of the three POST shapes above accepts `"pending": true`, which
creates the comment as a draft review comment:

```json
{
  "content": { "raw": "Nit: prefer a guard clause here." },
  "inline":  { "path": "src/parser.ts", "to": 118 },
  "pending": true
}
```

- The response (201) carries `"pending": true`. Published comments carry
  `"pending": false`.
- A draft is visible only to its author, both in the web UI and through
  the API (see the list endpoint above).
- **Publishing is web-UI only.** The author publishes all their drafts
  with **Finish Review** on the PR page. The public API has no publish
  or submit-review endpoint, and `PUT .../comments/{id}` rejects
  `pending` (`"extra keys not allowed"`). Editing a draft's `content`
  via PUT works and leaves it pending.
- Under `client_credentials` the draft would belong to the OAuth
  consumer, which can't sign in to the web UI to publish it. The
  comment tools therefore accept `pending` only in `authorization_code`
  mode.

---

## 5. Identity

```
GET /user
```

Returns the authenticated user's `uuid`, `display_name`, `username`
(deprecated but still present), and `account_id`. Called once at the end of
an `authorization_code` login; the result is stored with the token so
`whoami` needs no network call. Not used in `client_credentials` mode,
where there is no user.

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
- On `429` we retry any method, honoring `Retry-After` (seconds or
  HTTP-date). The request was rejected before processing, so resending is
  safe.
- On `5xx` we retry only idempotent methods (`GET`, `HEAD`, `PUT`,
  `DELETE`), with capped exponential backoff. A `POST` that gets a `5xx` is
  returned as an error at once: a gateway `502` can arrive after Bitbucket
  already created the comment or PR, so a resend would duplicate it.
- Up to 3 retries in either case.

---

## 7. Pipelines endpoints

All of these need the `pipeline` scope (Pipelines: Read on the consumer).
We treat it as optional: `bitbucket_get_pipeline_failures`, the only
consumer of these endpoints, is disabled when the token's `scopes` don't
include it. See the scopes table in §1.

### Get a pipeline

```
GET /repositories/{workspace}/{repo_slug}/pipelines/{pipeline_uuid}
```

Key fields: `uuid`, `build_number`, `state`. The path segment is
documented as a UUID; Atlassian staff have said a build number is also
accepted there, and we rely on that. A UUID's braces must be
percent-encoded (`%7B...%7D`).

`state.name` is `PENDING` / `IN_PROGRESS` / `COMPLETED`. Once completed,
`state.result.name` is `SUCCESSFUL` / `FAILED` / `ERROR` / `STOPPED` /
`EXPIRED`, and an `ERROR` result carries `state.result.error.message`
(e.g. invalid `bitbucket-pipelines.yml`, where no step ever runs).

### List steps

```
GET /repositories/{workspace}/{repo_slug}/pipelines/{pipeline_uuid}/steps
  ?pagelen=100
```

Paged. Each step has `uuid`, `name`, and a `state` shaped like the
pipeline's, with `NOT_RUN` as an extra result. We treat `FAILED` and
`ERROR` as failed.

### Get a step log

```
GET /repositories/{workspace}/{repo_slug}/pipelines/{pipeline_uuid}/steps/{step_uuid}/log
Accept: application/octet-stream
Range: bytes=-30720
```

Raw text, unbounded, often megabytes. We request only the tail with a
suffix `Range` and expect `206` with `Content-Range`. Once a step
completes the log moves to long-term storage and this endpoint answers
`307` to it; `fetch` follows the redirect and drops the `Authorization`
header on the cross-origin hop. `404` means the step has no log, and on
`416` we refetch without `Range` and tail locally.

### Test reports

```
GET .../pipelines/{pipeline_uuid}/steps/{step_uuid}/test_reports/test_cases
GET .../pipelines/{pipeline_uuid}/steps/{step_uuid}/test_reports/test_cases/{test_case_uuid}/test_case_reasons
```

Present only when the step produced JUnit-style XML that Pipelines picked
up; otherwise `404`. Bitbucket publishes no response schema for either
endpoint, so we read them loosely: a test case counts as failed when its
`status` is `FAILED` or `ERROR`, and the reasons payload is passed through
after sanitizing.

---

## Open questions

1. Capture a live `429` response to confirm the `Retry-After` header is set
   rather than only documented.
2. Exercise the Pipelines endpoints (§7) against a live failed build:
   build-number lookup, the test-report payload shapes, and the suffix
   `Range` request through the log redirect are all unverified.
