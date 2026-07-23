<!-- INDEX:START -->
## Index
- [Canonical Doc](#canonical-doc)
- [Scope](#scope)
- [Key Backend Areas](#key-backend-areas)
<!-- INDEX:END -->

## Canonical Doc
The canonical full backend reference is `docs/backend.md`.

## Scope
Covers the Console native Bun service, Hono app composition, static serving, API routes, SQLite state, GitHub pipeline, Beads/Dolt/JSONL sources, watcher/realtime channels, specialist observability, graph read models, terminal bridge, caching, degradation, production ops, and diagnostics.

## Key Backend Areas
- Entry: `apps/console/src/server/index.ts`
- App composition: `apps/console/src/server/host.ts`
- WebSocket hub: `apps/console/src/server/ws/*`
- Beads API/watchers: `apps/console/src/server/routes/*`, `packages/core/src/runtime/*`
- Graph: `apps/console/src/server/routes/graph.ts`, `packages/core/src/state/read-models/graph.ts`
- Specialists: `apps/console/src/server/routes/specialists.ts`, `apps/console/src/server/observability/*`
- Terminal: `apps/console/src/server/terminal/*`, `packages/core/src/terminal/*`
