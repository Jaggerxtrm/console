# Console backend

Status: current production reference.

## Ownership

- `apps/console/src/server/index.ts` is the Bun entrypoint.
- `apps/console/src/server/host.ts` composes HTTP, realtime, terminal, scanner,
  watcher, materializer, poller, and shutdown lifecycle.
- `apps/console/src/server/routes/` owns HTTP adapters and write-policy gates.
- `apps/console/src/server/ws/` owns Bun upgrade handling and protocol adapters.
- `apps/console/src/server/terminal/` owns the PTY boundary.
- `packages/core/src/` owns reusable state, materializer, runtime, GitHub,
  observability, and terminal contracts.

Console is the only runtime writer for an `xtrm.sqlite` database. A kernel-held
writer lease prevents a second host from starting against the same state.

## State

`XTRM_DATA_DIR` selects the state directory and defaults to
`~/.agent-forge`. `GITBOARD_DATA_DIR` remains accepted only as an environment
compatibility fallback; it does not select another implementation or schema.
No migration in the host-retirement work relocates or resets data.

The primary database remains `xtrm.sqlite`. Existing migrations, durable GitHub
state, materialization cursors, source health, forensic events, evidence refs,
and write controls are preserved.

## HTTP and realtime

The supported public surface is `/console`, `/health`, and the existing
`/api/*` and WebSocket protocols. `/gitboard` and old asset paths intentionally
return a permanent `308` redirect to `/console`; no legacy bundle is served.

Write routes remain protected by same-origin/admin proof. Internal verification
is interval-bounded and streams date-pruned logs instead of reading the log
directory into memory. Terminal defaults to disabled/no-leak and retains origin,
token, cwd, shell, rate, and TTL enforcement.

## Validation

```bash
bun run --cwd packages/core test
bun run --cwd apps/console test
bun run lint
bun run build
bun run --cwd apps/console smoke:api-contract
bun run --cwd apps/console smoke:lifecycle
bun run --cwd apps/console smoke:realtime
bun run --cwd apps/console smoke:terminal
bun run tools/retirement/host-retirement-guard.ts --mode strict
```

See `docs/deployment.md` for isolated staging, production observation, and
rollback-window rules.

## GitHub authentication (GitHub App user tokens)

Console can authenticate the operator as the `xtrm-console` GitHub App
(read-only: actions, checks, contents, issues, metadata, pull_requests,
statuses) through the OAuth device flow. When signed in, GitHub API calls made
by the passthrough routes (`/api/github/prs/.../checks`, PR detail, markdown,
reports, installations, capabilities) use the user token, refreshing it before
expiry, and fall back to the shared `GITHUB_TOKEN` / `gh auth token`
credential otherwise. The background poller keeps using the shared token it
resolved at startup.

### Configuration

| Variable | Meaning | Default |
|---|---|---|
| `XTRM_GITHUB_APP_CLIENT_ID` | GitHub App client ID. Missing -> auth status `not_configured` (never a crash) | unset |
| `XTRM_GITHUB_APP_SLUG` | App slug for install URLs | `xtrm-console` |
| `XTRM_GITHUB_APP_CLIENT_SECRET` | Client secret value (optional) | unset |
| `XTRM_GITHUB_APP_CLIENT_SECRET_FILE` | File holding the client secret | `~/.secrets/XTRM_GITHUB_APP_CLIENT_SECRET.txt` |
| `XTRM_GITHUB_TOKEN_STORE` | Force the token store: `file` | auto (keychain when available) |

The client secret is loaded at runtime only; operators store it with mode
`600`. The refresh grant does not require the secret for device-flow-minted
tokens (verified against GitHub docs 2026-09-16); when a refresh fails the
stored token moves to the `expired` state.

### Token storage

The signed-in user token is stored either in the host Secret Service
(libsecret via `secret-tool`, reported as `store: keychain`) or, when that is
unavailable, as `~/.xtrm/secrets/github-user-token.json` with mode `0600`
inside a `0700` directory (reported as `store: file`). Tokens never appear in
SQLite, logs, or HTTP responses.

### Endpoints

- `GET /api/github/auth/status` — `{ state, auth_source, store, user?, device?, error? }` with `state` in `not_configured|signed_out|pending|signed_in|expired|error`.
- `POST /api/github/auth/device/start` — starts the backend-polled device flow and returns the new auth-status object (`state: pending` + `device`); the backend honours the returned interval (>= 5 s) and `slow_down` (+5 s) and stops on `expired_token` / `access_denied`. `device/cancel` and `signout` likewise return the new auth-status object.
- `GET /api/github/auth/installations` — app installations visible to the user plus `install_url`.
- `GET /api/github/capabilities?repo=owner/repo` — `{ auth_source, installed, permissions, can }` read-capability map.
- `GET /api/github/prs/:owner/:repo/:number/checks` — check runs + commit statuses aggregate `{ state, checks, head_sha, mergeable, mergeable_state }` with the PR-detail TTL cache shape.

For tests, `XTRM_GITHUB_API_BASE_URL` and `XTRM_GITHUB_OAUTH_BASE_URL` redirect
the REST and OAuth base URLs at a fake GitHub server.
