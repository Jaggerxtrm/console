# forge-5a7f.10 deploy monitor

Verdict: PASS

Bead: forge-5a7f.10
Merge commit: 57df8d7 Merge forge-5a7f.10: static service parity blockers
Service: gitboard.service
Deploy time: 2026-07-05 01:42:25 CEST
ExecMainPID: 1074626
Artifact state: active/running
Window: 15 minutes, T+0/T+5/T+10/T+15

## Pre-deploy / Merge Gates

- Root pre-child build: PASS (`bun run build`).
- Root pre-child gitboard lint: PASS (`bun run --cwd apps/gitboard lint`).
- Root pre-child core lint: PASS (`bun run --cwd packages/core lint`).
- Root pre-child core tests: PASS (`bun run --cwd packages/core test`).
- Root pre-child app tests: first full run hit intermittent `attach-pool.test.ts` coverage mismatch; isolated test passed and full rerun passed.
- GitNexus impact: `createApp` in `apps/gitboard/src/api/server.ts` LOW, `startServer` LOW.
- Candidate worktree validation after dependency install: PASS (`bun run build`, gitboard/core lint, core runtime tests 8/8, app server runtime host tests 3/3).
- Root post-merge build: PASS (`bun run build`).
- Root post-merge gitboard lint: PASS (`bun run --cwd apps/gitboard lint`).
- Root post-merge core lint: PASS (`bun run --cwd packages/core lint`).
- Root post-merge core runtime tests: PASS (`bun run --cwd packages/core test -- tests/runtime-host.test.ts tests/runtime-ownership.test.ts`, 8 tests).
- Root post-merge app runtime host tests: PASS (`bun run --cwd apps/gitboard test -- tests/api/server-runtime-host.test.ts`, 3 tests).
- Obligations: CLEAN, job 6fc798.
- Seconder: 67b4cc returned FAIL because live static/service proof was not yet attached. This report supplies that proof.
- Test-runner jobs fdef91 and 116b14 crashed in specialist runtime; they are not counted as evidence.

## Static/Service Parity Table

No app-host static wrapper was deleted in this bead. The runtime descriptor now records retained static/service wrappers and blockers:

- `/console`: retained until production smoke proves first-viewport Console assets under the future daemon/static host.
- `/gitboard`: retained as legacy compatibility shell until replacement route has equivalent deployment proof.
- `/health`: retained while `gitboard.service` health checks target the app host.
- `runtime-descriptor`: retained as a bridge-era verification object until final wrapper cleanup.

## Deploy Gap Guard

`systemctl --user show gitboard.service -p ExecMainStartTimestamp -p ExecMainPID -p ActiveState -p SubState`

```text
ExecMainStartTimestamp=Sun 2026-07-05 01:42:25 CEST
ExecMainPID=1074626
ActiveState=active
SubState=running
```

The running service timestamp is newer than merge commit 57df8d7 and the post-merge validation.

## Samples

### T+0

Sample window: 2026-07-05T01:43-01:44+02:00

```text
/health 200 bytes=15
/console 200 bytes=408
/gitboard 200 bytes=410
/api/substrate/projects 200 bytes=7207
/api/feed 200 bytes=19154
/api/github/repos 200 bytes=12916
/api/sources 200 bytes=8163
/api/internal/verify-runtime with Host: localhost:3030 200 bytes=20658
```

Materializer proof:

```text
xtmux          44  dolt  dolt:fresh
market-data  1172  dolt  dolt:fresh
xtrm           35  dolt  dolt:fresh
```

Note: `/api/internal/verify-runtime` is localhost-gated by Host header. Because `gitboard.service` binds `HOST=100.113.49.52`, the valid live probe targets the tailnet socket with `Host: localhost:3030`.

### T+5

Sample: 2026-07-05T01:47:45+02:00

```text
/health 200 bytes=15
/console 200 bytes=408
/gitboard 200 bytes=410
/api/substrate/projects 200 bytes=7207
/api/feed 200 bytes=19154
/api/github/repos 200 bytes=13422
/api/sources 200 bytes=8163
/api/internal/verify-runtime with Host: localhost:3030 200 bytes=21436
```

Materializer proof:

```text
xtmux          44  dolt  dolt:fresh
market-data  1172  dolt  dolt:fresh
xtrm           35  dolt  dolt:fresh
```

Log verdict: no new static/service/runtime failures. Known scanner discovery noise only.

### T+10

Sample: 2026-07-05T01:53:02+02:00

```text
/health 200 bytes=15
/console 200 bytes=408
/gitboard 200 bytes=410
/api/substrate/projects 200 bytes=7207
/api/feed 200 bytes=19154
/api/github/repos 200 bytes=13422
/api/sources 200 bytes=8163
/api/internal/verify-runtime with Host: localhost:3030 200 bytes=22044
```

Materializer proof:

```text
xtmux          44  dolt  dolt:fresh
market-data  1172  dolt  dolt:fresh
xtrm           35  dolt  dolt:fresh
```

### T+15

Sample: 2026-07-05T01:58:00+02:00

```text
/health 200 bytes=15
/console 200 bytes=408
/gitboard 200 bytes=410
/api/substrate/projects 200 bytes=7207
/api/feed 200 bytes=19154
/api/github/repos 200 bytes=13422
/api/sources 200 bytes=8163
/api/internal/verify-runtime with Host: localhost:3030 200 bytes=22010
```

Materializer proof:

```text
xtmux          44  dolt  dolt:fresh
market-data  1172  dolt  dolt:fresh
xtrm           35  dolt  dolt:fresh
```

Service state:

```text
ExecMainStartTimestamp=Sun 2026-07-05 01:42:25 CEST
ExecMainPID=1074626
ActiveState=active
SubState=running
```

Focused runtime log verdict:

- No static asset serving error.
- No `/console` or `/gitboard` request failure.
- No health or runtime verify failure.
- No materializer or watcher exception.
- No fatal, panic, unhandled exception, request.error, 404, or 500 introduced by the touched surface.
- Scanner discovery noise remains known/non-regressive.

## Final Verdict

PASS. The static/service wrapper retirement decision is explicitly recorded in core runtime host metadata, no wrapper was deleted without parity proof, the production `gitboard.service` artifact is fresh, `/console`, `/gitboard`, `/health`, runtime verify, and core `/api/*` smoke checks stayed healthy for the full 15-minute window, and materialized counts for `market-data`, `xtrm`, and `xtmux` stayed stable/fresh.
