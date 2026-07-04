# forge-5a7f.8 deploy monitor

Verdict: PASS

Bead: forge-5a7f.8
Merge commit: 2c6a1e1 Merge forge-5a7f.8: realtime log runtime parity
Service: gitboard.service
Deploy time: 2026-07-04 23:55:12 CEST
ExecMainPID: 1509605
Artifact state: active/running
Window: 15 minutes, T+0/T+5/T+10/T+15

## Pre-deploy / Merge Gates

- Root post-merge build: PASS (`bun run build`).
- Root post-merge gitboard lint: PASS (`bun run --cwd apps/gitboard lint`).
- Root post-merge app ws/log tests: PASS (`bun run --cwd apps/gitboard test -- tests/api/routes/internal-logs.test.ts tests/api/ws/origin-policy.test.ts tests/api/ws/handler.test.ts tests/api/ws/realtime-contract.test.ts`, 22 tests).
- Root post-merge core lint: PASS (`bun run --cwd packages/core lint`).
- Root post-merge core runtime tests: PASS (`bun run --cwd packages/core test -- tests/runtime-realtime.test.ts tests/runtime-logs.test.ts`, 14 tests).
- Root post-merge smoke: PASS (`bun test ./apps/gitboard/tests/smoke/p3-ws-logs-parity.ts`, 1 test / 14 expects).
- Security: PASS/no findings, job e17e10.
- Obligations: CLEAN, job bc0074.
- Reviewer before deploy: PARTIAL, job aed085, solely pending live deploy proof.

## Deploy Gap Guard

`systemctl --user show gitboard.service -p ExecMainStartTimestamp -p ExecMainPID -p ActiveState -p SubState`

```text
ExecMainStartTimestamp=Sat 2026-07-04 23:55:12 CEST
ExecMainPID=1509605
ActiveState=active
SubState=running
```

The running service timestamp is newer than merge commit 2c6a1e1 and the post-merge validation.

Note: an initial probe at 2026-07-04T23:55:29+02:00 was discarded because the shell harness used `path` as a loop variable in zsh and shadowed `PATH`, causing local `curl`/`jq` command lookup failures. It did not exercise the service and is not counted.

## Live Realtime Proof

Unauthorized websocket origin:

```text
2026-07-04T23:55:43+02:00
hostile_origin_http=403 bytes=35
{"error":"websocket origin denied"}
```

Same-origin websocket connect:

```text
{"type":"connected","id":"ws-3"}
```

Same-origin websocket + internal client log broadcast:

```text
{"channel":"system","event":"system:log","component":"drawer","logEvent":"ui.live-smoke","source":"dashboard-client"}
```

## Samples

### T+0

Sample: 2026-07-04T23:55:43+02:00

```text
/health 200 bytes=15
/api/substrate/projects 200 bytes=7207
/api/feed 200 bytes=19154
/api/github/repos 200 bytes=12916
/api/sources 200 bytes=8163
/console 200 bytes=408
```

T+0 materializer/log scan completion sample: 2026-07-04T23:56:57+02:00

```text
market-data  1170  dolt  dolt:fresh
xtmux          44  dolt  dolt:fresh
xtrm           35  dolt  dolt:fresh
```

Focused log verdict: no ws/websocket/logger/log-write/materializer/watcher/terminal/fatal/panic/unhandled/request.error failures. Observed scanner discovery noise only: `git worktree probe miss` and `observability db miss`.

### T+5

Sample: 2026-07-05T00:00:23+02:00

```text
/health 200 bytes=15
/api/substrate/projects 200 bytes=7207
/api/feed 200 bytes=19154
/api/github/repos 200 bytes=13400
/api/sources 200 bytes=8163
/console 200 bytes=408
```

Materializer proof:

```text
market-data  1170  dolt  dolt:fresh
xtmux          44  dolt  dolt:fresh
xtrm           35  dolt  dolt:fresh
```

Focused log verdict: no new ws/websocket/logger/log-write/materializer/watcher/terminal/fatal/panic/unhandled/request.error failures. Known scanner discovery noise only.

### T+10

Sample: 2026-07-05T00:05:32+02:00

```text
/health 200 bytes=15
/api/substrate/projects 200 bytes=7207
/api/feed 200 bytes=19154
/api/github/repos 200 bytes=13422
/api/sources 200 bytes=8163
/console 200 bytes=408
```

Materializer proof:

```text
market-data  1170  dolt  dolt:fresh
xtmux          44  dolt  dolt:fresh
xtrm           35  dolt  dolt:fresh
```

Focused log verdict: no new touched-surface failures. Known scanner discovery noise repeated at the scheduled scan interval.

### T+15

Sample: 2026-07-05T00:10:43+02:00

```text
/health 200 bytes=15
/api/substrate/projects 200 bytes=7207
/api/feed 200 bytes=19154
/api/github/repos 200 bytes=13422
/api/sources 200 bytes=8163
/console 200 bytes=408
```

Materializer proof:

```text
market-data  1170  dolt  dolt:fresh
xtmux          44  dolt  dolt:fresh
xtrm           35  dolt  dolt:fresh
```

Service state:

```text
ExecMainStartTimestamp=Sat 2026-07-04 23:55:12 CEST
ExecMainPID=1509605
ActiveState=active
SubState=running
```

Focused runtime log verdict:

- No websocket/ws exception.
- No logger or log-write failure.
- No materializer exception.
- No watcher exception.
- No terminal runtime exception.
- No fatal, panic, or unhandled exception.
- Scanner discovery noise remains known/non-regressive.

## Final Verdict

PASS. The merged realtime/log runtime parity slice is running in `gitboard.service`, endpoint and console smokes stayed healthy for the 15-minute window, websocket hostile-origin rejection and same-origin `system:log` broadcast were proven live, materialized counts for `market-data`, `xtrm`, and `xtmux` remained stable/fresh, and logs did not show new failures in the touched runtime surfaces.
