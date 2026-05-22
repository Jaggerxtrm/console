# Omniforge

Agent orchestration + issue tracking monorepo. Primary app: `apps/gitboard`.

## Current run modes

### 1) Native systemd user service  
Primary deploy path.
- Service: `~/.config/systemd/user/gitboard.service`
- Starts app with Bun, no container layer
- Binds to Tailscale IP on host
- Needs `loginctl enable-linger <user>` so it survives logout

Quick start:
```bash
bun install
cd apps/gitboard
bun run build:dashboard
systemctl --user daemon-reload
systemctl --user enable --now gitboard
```

### 2) Docker / Compose  
Kept in tree, but experimental / not primary deploy.
- Useful for local reproduction
- Known gaps documented in `docs/deployment.md`

### 3) Dev mode  
For local hacking:
```bash
bun run dev
```

## Docs

- `docs/deployment.md` — native systemd + Tailscale runbook
- `apps/gitboard/CLAUDE.md` — app-specific notes
- `apps/gitboard/testing.md` — test guidance

## Monorepo layout

```
omniforge/
├── apps/
│   └── gitboard/          # GitHub Activity Dashboard
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
