# forge-5a7f.9 deploy monitor

Verdict: PASS

Bead: forge-5a7f.9
Merge commit: 8cef3ff Merge forge-5a7f.9: terminal safety runtime boundary
Service: gitboard.service
Deploy time: 2026-07-05 01:00:02 CEST
ExecMainPID: 3812809
Artifact state: active/running
Window: 15 minutes, T+0/T+5/T+10/T+15

## Pre-deploy / Merge Gates

- Root post-merge build: PASS (`bun run build`).
- Root post-merge gitboard lint: PASS (`bun run --cwd apps/gitboard lint`).
- Root post-merge core lint: PASS (`bun run --cwd packages/core lint`).
- Core terminal tests: PASS (`bun run --cwd packages/core test -- tests/terminal-policy.test.ts tests/terminal-protocol.test.ts`, 13 tests).
- App terminal/shell tests: PASS (`bun run --cwd apps/gitboard test -- tests/api/routes/shell.test.ts tests/api/routes/terminal.test.ts tests/api/terminal/provider-registry.test.ts tests/core/local-pty-provider.test.ts tests/core/shell-provider-policy.test.ts`, 34 tests).
- Security: PASS/no findings, job 11cead.
- Obligations: CLEAN, job 6d5fc4.
- Seconder: 27078a returned FAIL due cumulative epic `writer_diff` injection; direct child diff is only four terminal/shell files. This is recorded in bead notes.
- Pre-deploy reviewer: PARTIAL, job 0b78e9, pending security/obligations visibility and live proof.

## Deploy Gap Guard

`systemctl --user show gitboard.service -p ExecMainStartTimestamp -p ExecMainPID -p ActiveState -p SubState`

```text
ExecMainStartTimestamp=Sun 2026-07-05 01:00:02 CEST
ExecMainPID=3812809
ActiveState=active
SubState=running
```

The running service timestamp is newer than merge commit 8cef3ff and the post-merge validation.

## Live Terminal/Shell Proof

Production `gitboard.service` does not configure `GITBOARD_SHELL_PROVIDER_ADMIN_TOKEN`, so positive create/write/resize/dispose through the live websocket was not available. The live proof therefore covers the required negative side: no unauthenticated or hostile-origin shell access is exposed.

T+0 shell status:

```json
{
  "enabled": false,
  "disabledReason": "shell provider disabled by default",
  "adminOnly": null,
  "allowRemote": false
}
```

T+0 terminal providers:

```json
[
  { "kind": "specialist-feed", "enabled": false, "reason": "verified admin required for specialist feed" },
  { "kind": "pty", "enabled": false, "reason": "shell provider disabled by default" },
  { "kind": "tmux", "enabled": false, "reason": "provider disabled" },
  { "kind": "ssh", "enabled": false, "reason": "provider disabled" },
  { "kind": "command", "enabled": false, "reason": "provider disabled" }
]
```

Unauthorized websocket probes:

```text
terminal_hostile_origin_http=403 bytes=41
{"error":"shell websocket origin denied"}

terminal_same_origin_no_token_http=403 bytes=41
{"error":"shell websocket origin denied"}
```

## Samples

### T+0

Sample: 2026-07-05T01:00:20+02:00

```text
/health 200 bytes=15
/api/substrate/projects 200 bytes=7207
/api/feed 200 bytes=19154
/api/github/repos 200 bytes=12916
/api/sources 200 bytes=8163
/console 200 bytes=408
/api/console/shell/status 200 bytes=641
/api/console/terminal/status 200 bytes=375
```

Materializer proof:

```text
market-data  1172  dolt  dolt:fresh
xtmux          44  dolt  dolt:fresh
xtrm           35  dolt  dolt:fresh
```

Log verdict: no new terminal/shell/pty/materializer/watcher/fatal/panic/unhandled/request.error/log-write failures. Observed known scanner discovery noise only.

### T+5

Sample: 2026-07-05T01:05:32+02:00

```text
/health 200 bytes=15
/api/substrate/projects 200 bytes=7207
/api/feed 200 bytes=19154
/api/github/repos 200 bytes=13422
/api/sources 200 bytes=8163
/console 200 bytes=408
/api/console/shell/status 200 bytes=641
/api/console/terminal/status 200 bytes=375
```

Materializer proof:

```text
market-data  1172  dolt  dolt:fresh
xtmux          44  dolt  dolt:fresh
xtrm           35  dolt  dolt:fresh
```

Log verdict: no new touched-surface failures. Known scanner discovery noise only.

### T+10

Sample: 2026-07-05T01:10:42+02:00

```text
/health 200 bytes=15
/api/substrate/projects 200 bytes=7207
/api/feed 200 bytes=19154
/api/github/repos 200 bytes=13422
/api/sources 200 bytes=8163
/console 200 bytes=408
/api/console/shell/status 200 bytes=641
/api/console/terminal/status 200 bytes=375
```

Materializer proof:

```text
market-data  1172  dolt  dolt:fresh
xtmux          44  dolt  dolt:fresh
xtrm           35  dolt  dolt:fresh
```

Log verdict: no new touched-surface failures. Known scanner discovery noise repeated at scheduled scan interval.

### T+15

Sample: 2026-07-05T01:15:56+02:00

```text
/health 200 bytes=15
/api/substrate/projects 200 bytes=7207
/api/feed 200 bytes=19154
/api/github/repos 200 bytes=13422
/api/sources 200 bytes=8163
/console 200 bytes=408
/api/console/shell/status 200 bytes=641
/api/console/terminal/status 200 bytes=375
```

Materializer proof:

```text
market-data  1172  dolt  dolt:fresh
xtmux          44  dolt  dolt:fresh
xtrm           35  dolt  dolt:fresh
```

Service state:

```text
ExecMainStartTimestamp=Sun 2026-07-05 01:00:02 CEST
ExecMainPID=3812809
ActiveState=active
SubState=running
```

Focused runtime log verdict:

- No terminal websocket exception.
- No shell/PTY runtime exception.
- No materializer exception.
- No watcher exception.
- No fatal, panic, or unhandled exception.
- No request.error or log-write failure.
- Scanner discovery noise remains known/non-regressive.

## Final Verdict

PASS. The terminal/shell safety runtime boundary is running in `gitboard.service`, public endpoint smokes stayed healthy for the full 15-minute window, unauthenticated/hostile terminal websocket access remained denied, provider status remained disabled without an admin token, materialized counts for `market-data`, `xtrm`, and `xtmux` remained fresh, and logs showed no new failures in the touched runtime surfaces.
