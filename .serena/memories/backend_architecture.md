<!-- INDEX:START -->
## Index
- [Canonical Doc](#canonical-doc)
- [Scope](#scope)
- [Key Backend Areas](#key-backend-areas)
<!-- INDEX:END -->

## Canonical Doc
The canonical full backend reference is `docs/backend.md`.

## Scope
Covers Gitboard native Bun service startup, Hono app composition, static serving, API routes, SQLite store, GitHub pipeline, Beads/Dolt/JSONL sources, watcher/realtime channels, specialist observability, graph DAO, terminal bridge, caching, degradation, production ops, and diagnostics.

## Key Backend Areas
- Entry: `apps/gitboard/src/index.ts`
- App composition: `apps/gitboard/src/api/server.ts`
- WebSocket hub: `apps/gitboard/src/api/ws/*`
- Beads API/watchers: `apps/beadboard/src/api/routes/beads.ts`, `apps/beadboard/src/core/beads-change-watcher.ts`
- Graph: `apps/gitboard/src/api/routes/graph.ts`, `apps/gitboard/src/core/graph-dao.ts`
- Specialists: `apps/gitboard/src/api/routes/specialists.ts`, `apps/gitboard/src/server/observability/*`
- Terminal: `apps/gitboard/src/api/terminal/*`, `apps/gitboard/src/core/local-pty-provider.ts`
