# Console Test Guards

Status: current test guard checklist for cleanup, scaffold, and Console
readiness work.

Use this checklist for any implementation child that touches code, config,
package scripts, API routes, materializer behavior, dashboard rendering, or
deployment docs before closing the work. It protects the running Gitboard
service, the post-bridge materializer/API contract, and the Beads dependency
surfaces while cleanup and `apps/console` work proceeds.

Boundary ownership for these guards is defined in
`docs/architecture/console-architecture.md`. That document explains *why* a
guard exists; this document defines *what* command to run.

## 1. Required Baseline

Run these for any cleanup child that changes code, config, package scripts,
API routes, materializer behavior, dashboard rendering, or deployment docs:

```bash
bun run --cwd apps/gitboard typecheck
bun run --cwd apps/gitboard build:dashboard
git diff --check
```

Expected current caveat: `typecheck` may still fail until the post-bridge
TypeScript baseline burns down or splits. If it fails, the closing notes must
list the remaining errors and the bead that owns them.

## 2. Materializer And State Boundary

Run when touching `apps/gitboard/src/core/materializer`,
`apps/gitboard/src/core/xtrm-store.ts`, `apps/gitboard/src/api/server.ts`,
source scanning, or state table migrations:

```bash
bun run --cwd apps/gitboard test -- \
  tests/backend-boundaries/console-separation-boundary-contract.test.ts \
  tests/core/materializer.test.ts \
  tests/core/materializer/observability-adapter.test.ts \
  tests/core/materializer/beads-adapter.test.ts \
  tests/core/materializer/beads-snapshot-source.test.ts \
  tests/core/xtrm-store.test.ts
```

Assertions protected:

- materializer run/failure/cursor behavior remains observable;
- `specialist_forensic_events` and legacy fallback materialize correctly;
- Beads dependencies and tombstones survive materialization;
- `substrate_*` remains a bridge/projection table family, not native
  Substrate.

## 3. API Contracts

Run when touching `/api/feed`, `/api/specialists`, `/api/substrate`,
`/api/console/graph`, auth/admin gating, route composition, or DTO projection:

```bash
bun run --cwd apps/gitboard test -- \
  tests/api/feed-rollup-contract.test.ts \
  tests/api/routes/feed.test.ts \
  tests/api/routes/specialists.test.ts \
  tests/api/specialists.xtrm.test.ts \
  tests/api/routes/substrate.test.ts \
  tests/api/routes/graph.xtrm.test.ts
```

Assertions protected:

- `/api/specialists/jobs/:job_id/feed-events` remains
  canonical-envelope-first;
- `/api/feed` remains cursor-paginated rollup, not a raw envelope dump;
- malformed rows are redacted/materializer-owned;
- graph/substrate reads stay state-backed and repo-scoped.

## 4. Conditional API-Adjacent Guards

Run these only when the touched code can affect the named mounted surface.
They are not part of the required baseline because they are broader than the
core materializer/feed contract.

### 4.1 WebSocket Routing And Realtime Delivery

```bash
bun run --cwd apps/gitboard test -- \
  tests/api/ws/channels.test.ts \
  tests/api/ws/handler.test.ts \
  tests/api/ws/realtime-contract.test.ts
```

### 4.2 GitHub Adapter, Poller, Or Route Behavior

```bash
bun run --cwd apps/gitboard test -- \
  tests/api/routes/github.test.ts \
  tests/api/routes/github-detail-cache.test.ts \
  tests/api/routes/github-releases.test.ts \
  tests/core/github-poller.test.ts \
  tests/core/github-poller-loop.test.ts \
  tests/core/github-store.test.ts \
  tests/core/github-discover.test.ts
```

### 4.3 Console Shell, Terminal, Or Local Provider Policy

```bash
bun run --cwd apps/gitboard test -- \
  tests/api/routes/shell.test.ts \
  tests/api/routes/terminal.test.ts \
  tests/api/terminal/provider-registry.test.ts \
  tests/core/shell-provider-policy.test.ts \
  tests/core/local-pty-provider.test.ts
```

### 4.4 Sources, Scanner, Or Fold Migration

```bash
bun run --cwd apps/gitboard test -- \
  tests/api/routes/sources.test.ts \
  tests/api/routes/sources-policy.test.ts \
  tests/core/unified-scanner.test.ts \
  tests/core/fold-gitboard-sqlite.test.ts
```

### 4.5 Legacy /api/beads Retirement

Legacy `/api/beads` cache coverage is resolved by `forge-benk.10`: the route
stays retired and `tests/api/routes/beads.cache.test.ts` asserts that
`/api/substrate/projects` is the supported project read surface.

## 5. Prometheus And Operations Cardinality

Run when touching operations metrics, telemetry docs, fixtures, labels, or
any Prometheus-facing code:

```bash
bun run --cwd apps/gitboard test -- \
  tests/server/observability/prometheus-cardinality.test.ts
```

Forbidden-label list is defined once in
`docs/architecture/console-architecture.md` §8.1; drilldown must go through
forensic/evidence state, not Prometheus label cardinality.

## 6. Beads Feed And Console Regression Surface

Run when touching dashboard Beads feed, specialists feed rendering, graph
tabs, repo tree/source health, or shell navigation:

```bash
bun run --cwd apps/gitboard test -- \
  tests/dashboard/components/beads/BeadsRepoView.test.tsx \
  tests/dashboard/components/beads/IssueFeed.render.test.tsx \
  tests/dashboard/components/beads/IssueFeed.chip.test.tsx \
  tests/dashboard/components/beads/IssueFeed.identity.test.ts \
  tests/dashboard/components/shell/MainPane.beads-stability.test.tsx \
  tests/dashboard/pages/console/ChainDetailPane.test.tsx \
  tests/dashboard/pages/console/Graph.chip.test.tsx \
  tests/dashboard/pages/console/ia-restructure.test.tsx
```

Assertions protected:

- dependency tree, relationship labels, closed-history dependency expansion,
  and row identity survive cleanup;
- specialists forensic feed rendering remains available from chain/job
  detail;
- `/gitboard` remains the stable host surface while Console is the target;
- legacy/persisted Beads surface state maps to Console feed without visual
  redesign work in this cleanup track.

## 7. Repo Hygiene Guard

Run when touching ignore rules, generated outputs, smoke tests, or cleanup of
tracked runtime artifacts:

```bash
git ls-files \
  'apps/gitboard/data/*' \
  'apps/gitboard/logs/*' \
  '*.sqlite' \
  '*.db' \
  '*.log'
```

Allowed matches must be test fixtures or intentionally tracked examples.
Cleanup implementation belongs to dedicated cleanup beads (historically
`forge-benk.8`), not to this guard plan.

## 8. Live Tailscale Smoke

Run when touching deployment, port/host config, production static serving,
WebSocket routing, or dashboard build output:

```bash
curl -fsS http://100.113.49.52:3030/health
curl -fsS http://100.113.49.52:3030/gitboard
curl -fsS 'http://100.113.49.52:3030/api/feed?limit=5'
curl -fsS 'http://100.113.49.52:3030/api/console/graph?project_id=gitboard&refresh=true'
```

For specialists dependency rendering, use the existing Playwright live smoke
only after the dashboard bundle has been rebuilt and the service restarted:

```bash
bunx playwright test apps/gitboard/tests/e2e/specialists-live-dependencies.spec.cjs
```

## 9. Closure Rule

Every implementation child that triggers any of the guards above must list,
when closing:

- exact commands run;
- pass/fail result;
- any baseline failure that remains;
- follow-up bead IDs for failures intentionally deferred.

Do not close a child with only "build passed" when it touched materializer,
API, telemetry cardinality, Beads dependency rendering, or deployment
behavior.
