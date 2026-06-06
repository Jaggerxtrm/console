# Omniforge

Agent orchestration + issue tracking monorepo. Primary backend/materializer
service: `apps/gitboard`. Ready Console frontend app: `apps/console`.

## Current run modes

### 1) Native systemd user service  
Primary deploy path.
- Service: `~/.config/systemd/user/gitboard.service`
- Starts app with Bun, no container layer
- Binds to Tailscale IP on host
- Serves Console at `http://<tailnet-ip>:3030/console`
- Keeps `http://<tailnet-ip>:3030/gitboard` as the compatibility shell
- Needs `loginctl enable-linger <user>` so it survives logout

Quick start:
```bash
bun install
cd apps/gitboard
bun run build:dashboard
bun run --cwd ../console build
systemctl --user daemon-reload
systemctl --user enable --now gitboard
```

### 2) Docker / Compose  
Kept in tree, but experimental / not primary deploy.
- Useful for local reproduction
- Explicitly keeps `PORT=3000` and `GITBOARD_DATA_DIR=/data`
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
- `apps/gitboard/CLAUDE.md` — app-specific notes
- `apps/gitboard/testing.md` — test guidance

## Monorepo layout

```
omniforge/
├── apps/
│   ├── gitboard/          # Running backend, API, materializer, compatibility shell
│   └── console/           # Ready xtrm Console frontend app
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
