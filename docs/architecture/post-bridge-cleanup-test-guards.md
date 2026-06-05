# Post-Bridge Cleanup Test Guards

Status: `forge-benk.5` guard plan for cleanup and Console readiness work.

Use this checklist for `forge-benk` children before closing implementation
work. It protects the current running Gitboard service, the post-bridge
materializer/API contract, and the Beads dependency surfaces while cleanup and
future `apps/console` scaffold work proceeds.

## Required Baseline

Run these for any cleanup child that changes code, config, package scripts, API
routes, materializer behavior, dashboard rendering, or deployment docs:

```bash
bun run --cwd apps/gitboard typecheck
bun run --cwd apps/gitboard build:dashboard
git diff --check
```

Expected current caveat: `typecheck` may still fail until `forge-benk.2`
burns down or splits the post-bridge baseline. If it fails, the closing notes
must list the remaining errors and the bead that owns them.

## Materializer And State Boundary

Run when touching `apps/gitboard/src/core/materializer`,
`apps/gitboard/src/core/xtrm-store.ts`, `apps/gitboard/src/api/server.ts`,
source scanning, or state table migrations:

```bash
bun run --cwd apps/gitboard test -- \
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
- `substrate_*` remains a bridge/projection table family, not native Substrate.

## API Contracts

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

- `/api/specialists/jobs/:job_id/feed-events` remains canonical-envelope-first;
- `/api/feed` remains cursor-paginated rollup, not a raw envelope dump;
- malformed rows are redacted/materializer-owned;
- graph/substrate reads stay state-backed and repo-scoped.

## Prometheus And Operations Cardinality

Run when touching operations metrics, telemetry docs, fixtures, labels, or any
Prometheus-facing code:

```bash
bun run --cwd apps/gitboard test -- \
  tests/server/observability/prometheus-cardinality.test.ts
```

Forbidden labels remain: `job_id`, `bead_id`, `issue_id`, `chain_id`,
`participant_id`, `trace_id`, `span_id`, `tool_call_id`, path, command, URL,
raw error, diff, prompt, user, email, or token. Drilldown must go through
forensic/evidence state, not Prometheus label cardinality.

## Beads Feed And Console Regression Surface

Run when touching dashboard Beads feed, specialists feed rendering, graph tabs,
repo tree/source health, or shell navigation:

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
- specialists forensic feed rendering remains available from chain/job detail;
- `/gitboard` remains the stable host surface while Console is the target;
- legacy/persisted Beads surface state maps to Console feed without visual
  redesign work in this cleanup track.

## Repo Hygiene Guard

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
Current known cleanup candidates are:

- `apps/gitboard/data/audit.sqlite`
- `apps/gitboard/logs/2026-05-19.jsonl`

The cleanup implementation belongs to `forge-benk.8`, not to this guard plan.

## Live Tailscale Smoke

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

## Closure Rule

Every `forge-benk` implementation child must list:

- exact commands run;
- pass/fail result;
- any baseline failure that remains;
- follow-up bead IDs for failures intentionally deferred.

Do not close a child with only "build passed" when it touched materializer,
API, telemetry cardinality, Beads dependency rendering, or deployment behavior.
