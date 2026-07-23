# Dashboard performance and realtime validation

This folder contains the baseline instrumentation for `forge-ojn4`.

## Budgets

Use `DASHBOARD_PERFORMANCE_BUDGETS` from `realtime-helpers.ts` as the shared target for follow-up beads:

- WebSocket apply budget: `100ms` for local state updates after an event is received.
- API slow-log threshold: `500ms`.
- P95 targets for slow dashboard families:
  - `/api/console/graph`: `1500ms`
  - `/api/substrate/projects*`: `1000ms`
  - `/api/github/*` list endpoints: `1000ms`
  - `/api/specialists/jobs*`: `1000ms`
- Tab switches should not trigger unrelated endpoint families.
- Stale HTTP/cache payloads must never overwrite newer WebSocket state.

## Helpers

`realtime-helpers.ts` exports:

- `installFetchCallCounter()` — wraps `globalThis.fetch` and records request URLs by endpoint family.
- `preferFreshByTimestamp()` — small test merge function for updated-at/version freshness checks.
- `expectWsStateWinsOverStaleHttp()` — reusable assertion for the central realtime invariant.
- `DASHBOARD_SLOW_PATHS` — the slow endpoint families identified from logs.

## Commands

Run just this instrumentation:

```bash
bun --filter @xtrm/console test -- tests/dashboard/perf/dashboard-performance-budget.test.ts
```

Run the dashboard realtime/store checks most relevant to this epic:

```bash
bun --filter @xtrm/console test -- \
  tests/dashboard/perf/dashboard-performance-budget.test.ts \
  tests/dashboard/hooks/useGithubActivity.test.ts \
  tests/dashboard/stores/github-upsert.test.ts \
  tests/api/ws/realtime-contract.test.ts
```

Run the package type gate:

```bash
bun --filter @xtrm/console lint
```

## Follow-up usage

- `forge-ojn4.4`: use the fetch counter to prove inactive GitHub tabs do not fetch, and use `expectWsStateWinsOverStaleHttp()` around Query cache patchers.
- `forge-ojn4.6` / `forge-ojn4.8`: use fetch counts and route timing logs to prove cache hits avoid repeated graph/specialist reads.
- `forge-ojn4.7`: add 304, ETag, watermark, and rate-limit tests next to the GitHub poller tests.
- `forge-ojn4.10`: convert the invariant helpers into component-level smoke tests once tab-level lazy loading lands.
