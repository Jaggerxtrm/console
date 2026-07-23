# Read this first

## Trust order

1. Running code and tests in `apps/console` and `packages/core`.
2. `docs/backend.md` for the current host and state contract.
3. `docs/deployment.md` for production operations.
4. `docs/architecture/console-architecture.md` for component ownership.
5. Dated `.xtrm/reports`, dependency dossiers, migration specs, and preflight
   documents as historical evidence only.

## Current runtime

`console.service` starts `apps/console/src/server/index.ts`. Console owns the
HTTP server, API adapters, WebSockets, terminal security boundary, scanners,
watchers, materializer, GitHub poller, and static frontend. Reusable domain and
state logic lives in `packages/core`.

The removed host package must never be reintroduced as a production import,
workspace, service command, Docker path, or build entry. The retirement guard
enforces that boundary. Legacy URLs remain only as `308` redirects, and legacy
environment names remain compatibility fallbacks for in-place state.

## First commands

```bash
bun install --frozen-lockfile
bun run --cwd apps/console test
bun run --cwd packages/core test
bun run lint
bun run build
bun run tools/retirement/host-retirement-guard.ts --mode strict
```
