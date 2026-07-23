# Console deployment

Production runs the Bun host in `apps/console` as a systemd user service bound
to the host Tailscale address. The checked-in template is
`deploy/systemd/console.service`. Docker/Compose remains a local reproduction
path.

## Production contract

- `console.service` is the sole production writer and runtime owner.
- `ExecStart` must reference `apps/console/src/server/index.ts`.
- `/console`, `/health`, all existing `/api/*`, realtime, and terminal
  protocols remain unchanged.
- `/gitboard`, `/gitboard/*`, and old Gitboard asset paths return `308` to
  `/console`.
- `XTRM_DATA_DIR` is primary; `GITBOARD_DATA_DIR` remains a compatibility
  fallback. Cutover does not relocate or reset databases.
- Never start Console and Gitboard scanners/materializers against the same state
  database.

## Install

Build from the exact commit that will run:

```bash
bun install --frozen-lockfile
bun run build
install -Dm644 deploy/systemd/console.service ~/.config/systemd/user/console.service
install -d -m700 ~/.config/xtrm
```

Create `~/.config/xtrm/console.env` with mode `0600`. Keep secrets out of
the unit, repository, shell history, and journal. The unit deliberately does
not set a data directory: set either `XTRM_DATA_DIR` or the compatibility
`GITBOARD_DATA_DIR` to the exact directory used by the old service.

```dotenv
HOST=100.113.49.52
PORT=3030
XTRM_DATA_DIR=/home/dawid/.agent-forge
XDG_PROJECTS_DIR=/home/dawid
OBSERVABILITY_ROOTS=/home/dawid/dev/*,/home/dawid/projects/*
DOLT_HOST=127.0.0.1
LOG_DIR=/home/dawid/.xtrm/logs
XTRM_INTERNAL_VERIFY_TOKEN=<at-least-32-random-bytes>
GITBOARD_SPECIALISTS_BIN=/absolute/path/to/specialists
PATH=/home/dawid/.bun/bin:/absolute/specialists/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin
```

`XTRM_INTERNAL_VERIFY_TOKEN` authorizes non-loopback deploy-monitor requests
to `/api/internal/verify-runtime`. The legacy
`GITBOARD_INTERNAL_VERIFY_TOKEN` name remains accepted for rollback only.

Then validate and load the unit:

```bash
chmod 600 ~/.config/xtrm/console.env
systemd-analyze --user verify ~/.config/systemd/user/console.service
systemctl --user daemon-reload
```

## Isolated staging

Stage on `3031` with a temporary `XTRM_DATA_DIR`, temporary logs, and
isolated project roots. Do not point staging at production state or production
scanner roots.

```bash
env \
  NODE_ENV=production \
  HOST=127.0.0.1 \
  PORT=3031 \
  XTRM_DATA_DIR=/tmp/xtrm-console-stage/data \
  XDG_PROJECTS_DIR=/tmp/xtrm-console-stage/projects \
  OBSERVABILITY_ROOTS=/tmp/xtrm-console-stage/observability \
  LOG_DIR=/tmp/xtrm-console-stage/logs \
  SKIP_GITHUB_POLLER=1 \
  bun run start:console
```

Required staging gates:

```bash
bun run --cwd apps/console smoke:host
bun run --cwd apps/console smoke:api-parity
bun run --cwd apps/console smoke:lifecycle
bun run --cwd apps/console smoke:realtime
bun run --cwd apps/console smoke:terminal
bun run tools/retirement/host-retirement-guard.ts --mode strict
```

## Controlled cutover

The stop/start gap is intentional and must remain under 15 seconds. Capture the
old service state first, then stop the old writer before starting Console.

```bash
systemctl --user show gitboard.service \
  -p ActiveState -p SubState -p NRestarts -p MainPID -p MemoryCurrent -p ExecStart
systemctl --user stop gitboard.service
systemctl --user start console.service
systemctl --user is-active console.service
systemctl --user disable gitboard.service
systemctl --user enable console.service
```

Immediate HOLD conditions: either service has restarted, both services are
active, `/health` or `/console` fails, repeated API `5xx`, materializer
freshness stops, same-origin realtime fails, hostile-origin realtime/terminal
is accepted, terminal data leaks, or the verifier exceeds its bounded interval.

Rollback during the first observation window:

```bash
systemctl --user stop console.service
systemctl --user start gitboard.service
systemctl --user disable console.service
systemctl --user enable gitboard.service
```

Keep the disabled old unit and pre-cleanup worktree until both 60-minute
observation windows pass. Never overlap the services during rollback.

## Observation windows

Each production window records a T+0 artifact check and 12 absolute-time
samples at T+5 through T+60. Every sample captures:

- service active/substate, restarts, PID, memory, and exact `ExecStart`;
- `/health`, `/console`, `/gitboard` redirect, representative API status
  and response shape;
- source/materializer freshness and scanner discovery misses as a separate
  known-noise count;
- warning/error journal lines and structured lifecycle logs;
- tailnet edge reachability.

At T+0, T+15, T+30, and T+60 also run realtime handshake/replay,
hostile-origin, unauthenticated terminal no-leak, and authenticated bounded
verifier probes. The verifier request uses
`x-xtrm-internal-verify-token`; do not print the token.

Any restart, OOM, health/static failure, repeated API `5xx`, stale
materializer, websocket failure, hostile-origin acceptance, or terminal leak
produces immediate HOLD. Security failures or sustained service failures
trigger rollback.

Store the evidence at
`.xtrm/deploy-monitor/<bead>-pr<nr>-<sha>.md`. The running service start time
and entrypoint must be newer than the merged cutover commit before the window
can begin.

## Operations

```bash
journalctl --user -u console.service -n 100
journalctl --user -u console.service -f
systemctl --user show console.service \
  -p ActiveState -p SubState -p NRestarts -p MainPID -p MemoryCurrent -p ExecStart
tail -F ~/.xtrm/logs/$(date +%F).jsonl
```

Console is reached at `http://<tailnet-ip>:3030/console`. There is no public
bind, NAT rule, or `tailscale serve` layer.

## Environment

| Variable | Default | Purpose |
|---|---:|---|
| `HOST` | `127.0.0.1` in the unit | Set to the host tailnet IP in `console.env` |
| `PORT` | `3030` | Native service port; Docker uses `3000` |
| `XTRM_DATA_DIR` | `~/.agent-forge` | `xtrm.sqlite` and legacy fold input |
| `GITBOARD_DATA_DIR` | unset | Compatibility fallback only |
| `XDG_PROJECTS_DIR` | `~` in the unit | Scanner root |
| `OBSERVABILITY_ROOTS` | unset | Comma-separated observability roots |
| `DOLT_HOST` | `127.0.0.1` | Dolt SQL host |
| `LOG_DIR` | `~/.xtrm/logs` | Structured JSONL logs |
| `GITHUB_TOKEN` | `gh auth token` fallback | Headless GitHub API auth |
| `SKIP_GITHUB_POLLER` | unset | Disable GitHub poller for isolated staging |
| `XTRM_INTERNAL_VERIFY_TOKEN` | unset | 32+ byte deploy-monitor token |

## Docker reproduction

Compose uses the `console` service and `XTRM_DATA_DIR=/data`. It retains
the original `gitboard-state` resource key, so Compose resolves the same
project-scoped volume name used by existing local reproduction deployments.

```bash
docker compose build console
docker compose up -d console
curl -i http://127.0.0.1:3000/health
curl -i http://127.0.0.1:3000/gitboard
```
