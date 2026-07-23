# gitboard deployment

Primary deploy path: native Bun process under systemd user service, exposed
only through Tailscale on host. During the final runtime migration,
`gitboard.service` is a compatibility alias for the current Bun app entrypoint
until the core daemon unit replacement and static retirement probes are green.

## What won

- no container layer
- no `tailscale serve`
- no public bind / no ufw rule needed for app port
- bind app directly to tailnet IP on host
- Dolt stays local on host

Why not `tailscale serve` here:
- no HTTPS cert opt-in dance
- one less moving part
- simpler restart / log path
- tailnet access still private

## Native systemd user service

Create `~/.config/systemd/user/gitboard.service`:

```ini
[Unit]
Description=gitboard compatibility wrapper
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/dev/gitboard
Environment=HOST=100.113.49.52
Environment=PORT=3030
Environment=XDG_PROJECTS_DIR=%h/projects
Environment=DOLT_HOST=127.0.0.1
Environment=LOG_DIR=%h/.xtrm/logs
ExecStart=bun --cwd apps/gitboard src/index.ts
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
```

Adjust paths / tailnet IP for your host. The wrapper intentionally preserves
`HOST`, `PORT`, `GITBOARD_DATA_DIR`, `XDG_PROJECTS_DIR`, `DOLT_HOST`, and
`LOG_DIR`; do not change those during runtime ownership migration unless the
same change passes local/staging smoke and is easy to roll back.

Rollback path: keep this unit and keep the wrapper command unchanged. The core
daemon replacement may become the target later, but production should stay on
this compatibility wrapper until `/api/*`, WebSocket/log, terminal, `/console`,
and `/gitboard` probes all pass.

### First start

1. Enable linger so user service runs without active login session:
   ```bash
   loginctl enable-linger <user>
   ```
2. Prebuild dashboard on host:
   ```bash
   bun install
   cd apps/gitboard
   bun run build:dashboard
   bun run --cwd ../console build
   ```
3. Reload and start service:
   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now gitboard
   ```

Production restart is manual. Before a restart, capture local/staging evidence:
`bun run --cwd apps/gitboard smoke:deprecation`, static `/console` and
`/gitboard` probes, websocket/log probes, and materializer/channel log flow.

### Runbook

```bash
journalctl --user -u gitboard -n 100
systemctl --user restart gitboard
journalctl --user -u gitboard -f
tail -F ~/.xtrm/logs/$(date +%F).jsonl
```

## Tailscale-only access

- install Tailscale on host
- run `tailscale up` for auth
- bind `HOST` to host tailnet IP
- reach Console at `http://<tailnet-ip>:3030/console`
- reach compatibility Gitboard at `http://<tailnet-ip>:3030/gitboard`

No NAT, no public exposure, no extra firewall work for app port even if ufw stays open on other ports.

## Environment variables

| Var | Default | What it does | When override |
|---|---:|---|---|
| `HOST` | `0.0.0.0` in production, `127.0.0.1` in dev | Server bind address | Set to tailnet IP for native deploy |
| `PORT` | `3030` | HTTP listen port for the native Bun service | Set explicitly in systemd; Docker overrides to `3000` for local reproduction |
| `GITBOARD_DATA_DIR` | `~/.agent-forge` | Directory containing `xtrm.sqlite` plus legacy `gitboard.sqlite` fold input | Move DBs or isolate per host |
| `XDG_PROJECTS_DIR` | `~/projects` fallback | Scanner root for repo discovery | Point at alternate repo tree, e.g. nested `~/dev` + `~/projects` layouts |
| `DOLT_HOST` | `127.0.0.1` on native, `host.docker.internal` when `XDG_PROJECTS_DIR` is set | Dolt SQL host | Override when container / host routing differs |
| `LOG_DIR` | `~/.xtrm/logs` | JSONL log directory | Override for native host logs |
| `GITHUB_TOKEN` | `gh auth token` fallback where available | GitHub API auth | Set explicit token for headless service |
| `SKIP_GITHUB_POLLER` | unset | Disables GitHub poller | Use for manual-only / debugging runs |
| `LOG_LEVEL` | `info` | Logger verbosity | Raise to `debug` during incident work |
| `XTRM_INTERNAL_VERIFY_TOKEN` | unset | Strong token (32+ bytes) for non-loopback `/api/internal/verify-runtime` probes; legacy `GITBOARD_INTERNAL_VERIFY_TOKEN` is accepted | Set for authenticated deploy-monitor probes |

## Scanner behavior

- `XDG_PROJECTS_DIR` is scanner root, not single repo path.
- If unset, scanner falls back to `~/projects` when `HOME` exists, then `/home`.
- Nested layouts work: both `~/dev` and `~/projects` can be scanned if `XDG_PROJECTS_DIR` points at a parent that contains them.
- Shared-server repos are supported when `.beads/config.yaml` contains `dolt.shared-server: true` (or nested `dolt:\n  shared-server: true`).
- In that mode scanner reads `~/.beads/shared-server/dolt-server.port` and uses `metadata.json` `dolt_database` as DB name.

## Docker path status

Kept for local reproduction only.

Docker/Compose intentionally keep `PORT=3000` and map runtime state through
`GITBOARD_DATA_DIR=/data`. Native systemd remains the primary deployment path
and uses `PORT=3030` on the tailnet host.

Classification details live in `docs/architecture/console-architecture.md`
§10.

Known issues:
- Vite v7 `outDir` resolves under repo root in this setup
- `host.docker.internal` needs `DOLT_HOST` override in some runtimes
- custom bridge subnets can lose NAT on shared hosts
- PTY shells were containerized, which broke the winning deploy path

Use Docker only if you need to reproduce container behavior.

## Compatibility checks

```bash
curl http://<tailnet-ip>:3030/console
curl http://<tailnet-ip>:3030/gitboard
curl http://<tailnet-ip>:3030/health
```

Local static gate:

```bash
bun run --cwd apps/gitboard build:dashboard
bun run --cwd apps/console build
bash apps/gitboard/tests/smoke/p9-console-production-ready.sh
```
