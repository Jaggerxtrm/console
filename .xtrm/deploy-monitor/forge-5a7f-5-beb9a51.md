# forge-5a7f.5 Deploy Monitor

Commit: `beb9a51` (`fix: keep beads watcher out of browser runtime barrel`)
Service: `gitboard.service`
Deploy start: `2026-07-04T19:13:44+02:00`
ExecMainStartTimestamp: `Sat 2026-07-04 19:13:44 CEST`
ExecMainPID: `1028953`
Final service state: `active/running`

## Build And Test Gate

- `bun run build`: PASS
- `bun test apps/gitboard/tests/api/server-runtime-host.test.ts`: PASS, 3 tests
- `bun test packages/core/tests/runtime-beads-watcher.test.ts`: PASS, 7 tests
- `bun run --cwd packages/core test`: PASS, 125 passed / 26 skipped
- `bun run --cwd packages/core lint`: PASS
- `bun run --cwd apps/gitboard lint`: PASS
- `bun run --cwd apps/gitboard test`: PASS, 648 passed / 2 skipped

## Smoke Samples

| Sample | `/health` | `/api/substrate/projects` | `/api/feed` | `/api/github/repos` | `/api/sources` | `/console` |
| --- | --- | --- | --- | --- | --- | --- |
| T+0 | 200 | 200 | 200 | 200 | 200 | 200 |
| T+5 `2026-07-04T19:19:46+02:00` | 200 | 200 | 200 | 200 | 200 | 200 |
| T+10 `2026-07-04T19:24:47+02:00` | 200 | 200 | 200 | 200 | 200 | 200 |
| T+15 `2026-07-04T19:29:47+02:00` | 200 | 200 | 200 | 200 | 200 | 200 |

## Materializer Counts

| Sample | market-data | xtrm | xtmux |
| --- | ---: | ---: | ---: |
| T+0 | 1168 | 35 | 44 |
| T+5 | 1168 | 35 | 44 |
| T+10 | 1168 | 35 | 44 |
| T+15 | 1168 | 35 | 44 |

All three sampled projects reported `source=dolt` and `sourceHealth=dolt:fresh`.

## Logs

`journalctl --user -u gitboard.service --since "2026-07-04 19:13:44"` showed no crash, restart loop, or new watcher/materializer/websocket/terminal failure during the window.

Observed `error` matches were limited to known scanner startup noise:

- optional observability DB `ENOENT` misses for directories without `.specialists/observability.db`
- git worktree probe `ENOENT` misses for non-repo directories under broad scan roots

## Verdict

PASS. The post-merge `.5` regression fix deployed, endpoints stayed healthy for 15 minutes, materialized counts stayed stable, and logs show no new runtime failure in the touched watcher/materializer surface.
