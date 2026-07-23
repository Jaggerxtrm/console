# @xtrm/console

The Console package owns the production Bun/Hono host and the React frontend.
It serves `/console`, `/health`, `/api/*`, realtime WebSockets, and the terminal
boundary from `src/server/index.ts`.

## Development

Run the host and Vite frontend in separate terminals:

```bash
bun run start:console
bun run --cwd apps/console dev
```

The host defaults to `127.0.0.1:3030`. Vite serves
`http://localhost:5174/console/` and proxies `/api` and `/ws` to the host.

## Validation

```bash
bun run --cwd apps/console test
bun run --cwd apps/console typecheck
bun run --cwd apps/console build
bun run --cwd apps/console smoke:api-contract
bun run --cwd apps/console smoke:lifecycle
```

Production deployment and observation gates are documented in
`docs/deployment.md`.
