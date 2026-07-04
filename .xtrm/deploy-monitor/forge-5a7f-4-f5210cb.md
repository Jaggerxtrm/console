# forge-5a7f.4 deploy monitor

Child: `forge-5a7f.4`
Commit: `f5210cb` (`chore: close forge-5a7f.4`)
Runtime change: `509a18a` (`refactor: move source refresh lifecycle into core`)
Service: `gitboard.service`

## Deploy Freshness

- Deploy command: `systemctl --user restart gitboard.service`
- Deploy requested: `2026-07-04T17:32:06+02:00`
- `ExecMainStartTimestamp=Sat 2026-07-04 17:32:06 CEST`
- `ExecMainPID=827809`
- Final state: `ActiveState=active`, `SubState=running`

## Pre-Deploy Regression Gates

- `bun run --cwd apps/gitboard test`: PASS (`/tmp/forge-5a7f-4-gitboard-test.log`, 120 files, 647 passed, 2 skipped)
- `bun run --cwd apps/gitboard lint`: PASS (`/tmp/forge-5a7f-4-gitboard-lint.log`)
- `bun run --cwd packages/core test`: PASS (`/tmp/forge-5a7f-4-core-test.log`, 21 files passed, 118 tests passed, 26 skipped)
- `bun run --cwd packages/core lint`: PASS (`/tmp/forge-5a7f-4-core-lint.log`)
- `bun run build`: PASS (`/tmp/forge-5a7f-4-build.log`)
- Targeted scanner/source lifecycle tests: PASS
  - `bun run --cwd packages/core test -- tests/source-refresh-lifecycle.test.ts`
  - `bun run --cwd apps/gitboard test -- tests/core/unified-scanner.test.ts tests/core/unified-scanner.live.test.ts tests/api/routes/sources.test.ts tests/api/routes/sources-policy.test.ts`
  - `bun run --cwd apps/gitboard tests/smoke/p1-unified-scanner-smoke.ts`

## GitNexus Evidence

- Pre-edit impact:
  - `ProjectScanner`: CRITICAL; 28 impacted, 13 direct, 5 process flows.
  - `UnifiedScanner`: LOW; 6 impacted, 1 process flow.
- Decision: do not move `ProjectScanner` in this child; only move the scheduler/start/stop/refresh-in-flight lifecycle behind `packages/core`.
- Pre-commit detect-changes: MEDIUM; expected `CreateApp` source lifecycle flows plus pre-existing `MainPane` baseline-fix flow.

## Smoke Samples

Base URL: `http://100.113.49.52:3030`

| Sample | Time | PID | Health | Projects | Feed | GitHub Repos | Sources | Console |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- |
| T+0 | 2026-07-04T17:33:51+02:00 | 827809 | 200 | 200 | 200 | 200 | 200 | 200 |
| T+5 | 2026-07-04T17:39:00+02:00 | 827809 | 200 | 200 | 200 | 200 | 200 | 200 |
| T+10 | 2026-07-04T17:44:12+02:00 | 827809 | 200 | 200 | 200 | 200 | 200 | 200 |
| T+15 | 2026-07-04T17:47:23+02:00 | 827809 | 200 | 200 | 200 | 200 | 200 | 200 |

## Materializer Count Proof

Endpoint: `/api/substrate/projects`

| Project | T+0 | T+5 | T+10 | T+15 |
| --- | ---: | ---: | ---: | ---: |
| `market-data` | 1163 | 1163 | 1163 | 1163 |
| `xtrm` | 35 | 35 | 35 | 35 |
| `xtmux` | 44 | 44 | 44 | 44 |

Source endpoint proof:

- `market-data`: beads source active, observability source active.
- `xtrm`: beads source active, observability source active.
- `xtmux`: beads source active, observability source missing.

This specifically disproves the old live symptom where `xtrm` and `xtmux` appeared with `bd:0` in the UI materialized list during the previous incident window.

## Log Review

Command scope:

- `journalctl --user -u gitboard.service --since '2026-07-04 17:32:06' --no-pager`
- Filters included `error|exception|failed|panic|unhandled|materializer|scanner|watcher|ws|terminal`.

Findings:

- No service restart, crash, panic, unhandled exception, materializer crash, watcher crash, websocket crash, or terminal crash observed during the monitor window.
- GitHub poller started normally:
  - `[github-discover] Found 34 repos via gh CLI`
  - `[github-discover] 23 repos match filters (of 34 discovered)`
  - `[gitboard] GitHub startup backfill skipped: set GITBOARD_STARTUP_BACKFILL=1 to enable`
  - `[gitboard] GitHub poller running for Jaggerxtrm`
- Residual log noise: 1144 lines matched `error|exception|failed|panic|unhandled`, all sampled matches were expected scanner optional observability DB misses:
  - `[scanner] observability db miss ... Error: ENOENT: no such file or directory`
  - This is already tracked by `forge-ice5.7` and did not crash the scanner or service.

## Verdict

PASS for `forge-5a7f.4` post-deploy monitor.

Residual risk: scanner optional observability DB miss logging remains too noisy and can hide real errors in future monitor windows. Keep `forge-ice5.7` open; do not count that noise as a `.4` runtime regression.
