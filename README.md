# Omniforge

Agent orchestration + issue tracking monorepo. `apps/console` owns the Bun
production host, HTTP API, WebSockets, terminal boundary, lifecycle runtime,
and Console frontend. `packages/core` owns reusable runtime and state logic.
`apps/gitboard` is retained only as a temporary rollback package until the
post-cutover cleanup window passes.

## Current run modes

### 1) Native systemd user service
Primary deploy path.
- Service: `~/.config/systemd/user/console.service`
- Starts `apps/console/src/server/index.ts` with Bun, no container layer
- Binds to Tailscale IP on host
- Serves Console at `http://<tailnet-ip>:3030/console`
- Permanently redirects `http://<tailnet-ip>:3030/gitboard*` to `/console`
- Production restart remains manual after local/staging smoke and log evidence
- Needs `loginctl enable-linger <user>` so it survives logout

Quick start:
```bash
bun install
cd apps/console
bun run build
systemctl --user daemon-reload
systemctl --user enable --now console
```

Rollback during the observation window: stop `console.service`, then re-enable
the preserved `gitboard.service`. Never run both against production state.

### 2) Docker / Compose  
Kept in tree, but experimental / not primary deploy.
- Useful for local reproduction
- Explicitly keeps `PORT=3000` and `XTRM_DATA_DIR=/data`
- Known gaps documented in `docs/deployment.md`

### 3) Dev mode  
For local hacking:
```bash
bun run dev
```

The API defaults to `:3030`; the Vite dashboard dev server proxies `/api` and
`/ws` to that port.

## Docs

- `docs/READ_THIS_FIRST.md` — documentation entrypoint and trust order
- `docs/deployment.md` — native systemd + Tailscale runbook
- `docs/architecture/console-architecture.md` — UI/API/materializer/state
  ownership, materializer contract, current repo state, and dormant tooling
  classification
- `docs/architecture/console-observability-spec.md` — Console observability
  spec, Slices A–F (datasource, panels, source health, evidence UX, journal)
- `docs/architecture/console-test-guards.md` — test command checklist for
  cleanup, scaffold, and Console readiness work
- `docs/architecture/apps-console-scaffold-preflight.md` — completed scaffold
  checklist and boundary reference
- `apps/console/src/server/` — production host and runtime boundaries

## Monorepo layout

```
omniforge/
├── apps/
│   ├── gitboard/          # Temporary rollback package pending deletion
│   └── console/           # Production host and xtrm Console frontend
├── packages/
│   ├── core/              # @omniforge/core - shared utilities and types
│   ├── ui/                # @omniforge/ui - design system components
│   └── api-client/        # @omniforge/api-client - REST + WebSocket client
└── pnpm-workspace.yaml
```

## Package entry points

- `@omniforge/core` — formatting, dates, shared types
- `@omniforge/ui` — design system components
- `@omniforge/api-client` — REST + WebSocket client

## License

MIT
