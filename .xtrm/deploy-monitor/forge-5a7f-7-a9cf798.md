# Deploy Monitor: forge-5a7f.7

Issue: `forge-5a7f.7`  
Merge commit: `a9cf798` (`Merge forge-5a7f.7: extract materializer runtime boundary`)  
Service: `gitboard.service`  
Deploy start: `2026-07-04T20:13:30+02:00`  
ExecMainStartTimestamp: `Sat 2026-07-04 20:13:30 CEST`  
ExecMainPID: `3311163`  
Final state: `active/running`

## Scope

Moved the beads materializer runtime boundary into `packages/core/src/materializer` while keeping `apps/gitboard` as a host adapter for Dolt/jsonl snapshot reads and app logging. Public `/api/*` shapes, trigger wiring, source-health behavior, resync/delta behavior, and tombstone behavior were preserved.

## Pre-Merge Review Chain

- Executor: `54b10b`, commit `f5dadca`
- Seconder: initial cumulative false fail `3c4c9f`; scoped recheck PASS `711a5d`
- Test engineer: `fccc68`, no extra tests required beyond added boundary coverage
- Test runner: `0cd22a`, manual command evidence captured because payload was incomplete
- Obligations scanner: `e1e919`, CLEAN
- Reviewer: `2f07d9`, PASS, score 92
- Security auditor: skipped; scoped diff did not touch auth, terminal, permissions, secrets, dependencies, or migrations

## Validation Evidence

Post-merge root validation after `a9cf798`:

- `bun run build`: PASS (`/tmp/forge-5a7f-7-merged-build.log`)
- `bun run --cwd packages/core test`: PASS (`/tmp/forge-5a7f-7-merged-core-test.log`; 23 files passed, 4 skipped; 130 tests passed, 26 skipped)
- `bun run --cwd packages/core lint`: PASS (`/tmp/forge-5a7f-7-merged-core-lint.log`)
- `bun run --cwd apps/gitboard lint`: PASS (`/tmp/forge-5a7f-7-merged-gitboard-lint.log`)
- `bun run --cwd apps/gitboard test`: PASS on full rerun (`/tmp/forge-5a7f-7-merged-gitboard-test-rerun.log`; 120 files, 648 passed, 2 skipped)
- `bun run --cwd apps/gitboard test -- tests/core/logger.test.ts`: PASS on isolated rerun after one timing-flake failure (`/tmp/forge-5a7f-7-logger-vitest-rerun.log`; 7 passed)

Targeted materializer gate evidence:

- `bun x vitest run packages/core/tests/materializer-beads-adapter.test.ts packages/core/tests/materializer.test.ts`: PASS, 9 tests
- `bun test apps/gitboard/tests/core/materializer/beads-adapter.test.ts apps/gitboard/tests/core/materializer/observability-adapter.test.ts apps/gitboard/tests/core/materializer.test.ts`: PASS, 13 tests
- `bun apps/gitboard/tests/smoke/p2-beads-adapter.ts`: PASS (`active_rows=1`, `tombstones=1`, `ws_hints=3`)
- `bun apps/gitboard/tests/smoke/p4-graph-degraded.ts`: PASS from root dependency environment. The isolated executor worktree failed only because `hono` was unavailable there.

GitNexus:

- Pre-edit impact: app `Materializer` LOW, core `Materializer` LOW, `BeadsAdapter` LOW.
- Post-merge `detect-changes --scope compare --base-ref origin/main`: HIGH cumulative integration scope because it includes earlier `.4`, `.5`, `.7`, UI/cache commits. The scoped `.7` diff had reviewer PASS and all gates above.

## Smoke Samples

Base URL: `http://100.113.49.52:3030`

| Sample | Timestamp | `/health` | `/api/substrate/projects` | `/api/feed` | `/api/github/repos` | `/api/sources` | `/console` |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| T+0 | `2026-07-04T20:14:53+02:00` | 200 | 200 | 200 | 200 | 200 | 200 |
| T+5 | `2026-07-04T20:18:30+02:00` | 200 | 200 | 200 | 200 | 200 | 200 |
| T+10 | `2026-07-04T20:23:30+02:00` | 200 | 200 | 200 | 200 | 200 | 200 |
| T+15 | `2026-07-04T20:28:30+02:00` | 200 | 200 | 200 | 200 | 200 | 200 |

Representative response sizes remained stable:

- `/health`: 15 bytes
- `/api/substrate/projects`: 7207 bytes
- `/api/feed`: 19154 bytes
- `/api/github/repos`: 12916 to 13422 bytes
- `/api/sources`: 8163 bytes
- `/console`: 408 bytes

## Materializer Counts

Counts stayed stable across T+0, T+5, T+10, and T+15:

| Project | Count | Source | Source Health |
| --- | ---: | --- | --- |
| `market-data` | 1168 | `dolt` | `dolt:fresh` |
| `xtrm` | 35 | `dolt` | `dolt:fresh` |
| `xtmux` | 44 | `dolt` | `dolt:fresh` |

Baseline from `forge-5a7f.5` monitor was `market-data=1168`, `xtrm=35`, `xtmux=44`; no materializer regression was observed.

## Log Scan

Command:

```bash
journalctl --user -u gitboard.service --since '2026-07-04 20:13:30' --no-pager \
  | rg -i 'error|exception|fatal|panic|unhandled|watcher|materializer|terminal|websocket|ws'
```

Verdict: PASS.

Observed matches were the known scanner observability DB miss messages (`ENOENT` while probing optional `.specialists/observability.db` paths). No new materializer, watcher, websocket, terminal, fatal, panic, or unhandled failures were observed during the deploy window.

## Result

`forge-5a7f.7` is safe to close: reviewer PASS, build/test/lint PASS, service freshness proved, endpoint smoke PASS, materializer counts stable, and post-deploy logs clean except for known scanner observability probe noise.
