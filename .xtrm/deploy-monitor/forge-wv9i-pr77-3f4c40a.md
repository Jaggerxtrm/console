# Deploy Monitor: forge-wv9i / PR 77 / 3f4c40a

- Verdict: PASS
- Merge: 3f4c40ac70160ada2bc3ad07f355cf7c5ed26b1c at 2026-07-23T09:34:37Z
- Window start: 2026-07-23T09:38:14Z
- Schedule: T+5 through T+60, 12 samples at five-minute absolute intervals
- Service: console.service
- ExecStart: /home/dawid/dev/console/.worktrees/production-console-cleanup/apps/console/src/server/index.ts
- State database directory: /home/dawid/.agent-forge (unchanged)
- Cutover gap: 2898 ms, measured from stop initiation through the first healthy
  tailnet response; PID changed from 1244490 to 4121667 with the old service
  inactive before the new writer started.
- T+0: exact merge artifact; owner apps/console; health/console 200; /gitboard/* 308; API/feed/sources 200; verifier 200 in 75 ms with bounded memory; realtime handshake/replay PASS; hostile realtime 403; terminal no-token/hostile 403; NRestarts=0.
- Known noise: watcher.skip ENOENT discovery misses are counted separately.
- Edge-probe warning: no separate external edge-probe configuration exists, so
  that optional check was skipped. The native tailnet endpoint
  `http://100.113.49.52:3030` was probed successfully at every sample.

## Samples
- T+5m OK @ 2026-07-23T09:43:14Z: active=active/running restarts=0 pid=4121667 memory=132952064 oom=0/0; old=inactive; health=apps/console console=200 redirect=308; projects=200/21 sources=200/37(active=36 missing=1 latest=2026-07-23 09:38:15) feed=200/1 terminal=200; materializer=21 latest=2026-07-23T09:38:23.533Z; journal_errors=0 structured_errors=0 unexpected_warnings=0 scanner_noise=70
- T+10m OK @ 2026-07-23T09:48:14Z: active=active/running restarts=0 pid=4121667 memory=135995392 oom=0/0; old=inactive; health=apps/console console=200 redirect=308; projects=200/21 sources=200/37(active=36 missing=1 latest=2026-07-23 09:38:15) feed=200/1 terminal=200; materializer=21 latest=2026-07-23T09:38:23.533Z; journal_errors=0 structured_errors=0 unexpected_warnings=0 scanner_noise=140
- T+15m OK @ 2026-07-23T09:53:14Z: active=active/running restarts=0 pid=4121667 memory=134914048 oom=0/0; old=inactive; health=apps/console console=200 redirect=308; projects=200/21 sources=200/37(active=36 missing=1 latest=2026-07-23 09:48:15) feed=200/1 terminal=200; materializer=21 latest=2026-07-23T09:38:23.533Z; journal_errors=0 structured_errors=0 unexpected_warnings=0 scanner_noise=210; security={"result":"PASS","label":"t15","handshake":"connected","replay":true,"malformedSurvived":true,"hostileRealtime":403,"terminalNoToken":403,"terminalHostile":403}; verifier=200/98 ms/{"error_count":0,"p95_ms":0,"breaches":0}/{"files_seen":9,"files_opened":1,"files_pruned":8,"lines_scanned":20389,"file_errors":0,"duration_ms":72}/mem 136007680->151142400
- T+20m OK @ 2026-07-23T09:58:14Z: active=active/running restarts=0 pid=4121667 memory=137011200 oom=0/0; old=inactive; health=apps/console console=200 redirect=308; projects=200/21 sources=200/37(active=36 missing=1 latest=2026-07-23 09:48:15) feed=200/1 terminal=200; materializer=21 latest=2026-07-23T09:38:23.533Z; journal_errors=0 structured_errors=0 unexpected_warnings=0 scanner_noise=280
- T+25m OK @ 2026-07-23T10:03:14Z: active=active/running restarts=0 pid=4121667 memory=136982528 oom=0/0; old=inactive; health=apps/console console=200 redirect=308; projects=200/21 sources=200/37(active=36 missing=1 latest=2026-07-23 09:58:15) feed=200/1 terminal=200; materializer=21 latest=2026-07-23T09:38:23.533Z; journal_errors=0 structured_errors=0 unexpected_warnings=0 scanner_noise=350
- T+30m OK @ 2026-07-23T10:08:14Z: active=active/running restarts=0 pid=4121667 memory=143060992 oom=0/0; old=inactive; health=apps/console console=200 redirect=308; projects=200/21 sources=200/37(active=36 missing=1 latest=2026-07-23 10:08:15) feed=200/1 terminal=200; materializer=23 latest=2026-07-23T10:04:46.406Z; journal_errors=0 structured_errors=0 unexpected_warnings=0 scanner_noise=420; security={"result":"PASS","label":"t30","handshake":"connected","replay":true,"malformedSurvived":true,"hostileRealtime":403,"terminalNoToken":403,"terminalHostile":403}; verifier=200/129 ms/{"error_count":0,"p95_ms":221,"breaches":0}/{"files_seen":9,"files_opened":1,"files_pruned":8,"lines_scanned":20775,"file_errors":0,"duration_ms":103}/mem 145391616->150020096
- T+35m OK @ 2026-07-23T10:13:14Z: active=active/running restarts=0 pid=4121667 memory=143654912 oom=0/0; old=inactive; health=apps/console console=200 redirect=308; projects=200/21 sources=200/37(active=36 missing=1 latest=2026-07-23 10:08:15) feed=200/1 terminal=200; materializer=23 latest=2026-07-23T10:04:46.406Z; journal_errors=0 structured_errors=0 unexpected_warnings=0 scanner_noise=490
- T+40m OK @ 2026-07-23T10:18:14Z: active=active/running restarts=0 pid=4121667 memory=142438400 oom=0/0; old=inactive; health=apps/console console=200 redirect=308; projects=200/21 sources=200/37(active=36 missing=1 latest=2026-07-23 10:08:15) feed=200/1 terminal=200; materializer=23 latest=2026-07-23T10:04:46.406Z; journal_errors=0 structured_errors=0 unexpected_warnings=0 scanner_noise=560
- T+45m OK @ 2026-07-23T10:23:14Z: active=active/running restarts=0 pid=4121667 memory=143458304 oom=0/0; old=inactive; health=apps/console console=200 redirect=308; projects=200/21 sources=200/37(active=36 missing=1 latest=2026-07-23 10:18:15) feed=200/1 terminal=200; materializer=23 latest=2026-07-23T10:04:46.406Z; journal_errors=0 structured_errors=0 unexpected_warnings=0 scanner_noise=630
- T+50m OK @ 2026-07-23T10:28:14Z: active=active/running restarts=0 pid=4121667 memory=146022400 oom=0/0; old=inactive; health=apps/console console=200 redirect=308; projects=200/21 sources=200/37(active=36 missing=1 latest=2026-07-23 10:18:15) feed=200/1 terminal=200; materializer=23 latest=2026-07-23T10:04:46.406Z; journal_errors=0 structured_errors=0 unexpected_warnings=0 scanner_noise=700
- T+55m OK @ 2026-07-23T10:33:14Z: active=active/running restarts=0 pid=4121667 memory=144449536 oom=0/0; old=inactive; health=apps/console console=200 redirect=308; projects=200/21 sources=200/37(active=36 missing=1 latest=2026-07-23 10:28:15) feed=200/1 terminal=200; materializer=23 latest=2026-07-23T10:04:46.406Z; journal_errors=0 structured_errors=0 unexpected_warnings=0 scanner_noise=770
- T+60m OK @ 2026-07-23T10:38:15Z: active=active/running restarts=0 pid=4121667 memory=147050496 oom=0/0; old=inactive; health=apps/console console=200 redirect=308; projects=200/21 sources=200/37(active=36 missing=1 latest=2026-07-23 10:38:15) feed=200/1 terminal=200; materializer=25 latest=2026-07-23T10:36:13.286Z; journal_errors=0 structured_errors=0 unexpected_warnings=0 scanner_noise=840; security={"result":"PASS","label":"t60","handshake":"connected","replay":true,"malformedSurvived":true,"hostileRealtime":403,"terminalNoToken":403,"terminalHostile":403}; verifier=200/180 ms/{"error_count":0,"p95_ms":176,"breaches":0}/{"files_seen":9,"files_opened":1,"files_pruned":8,"lines_scanned":21672,"file_errors":0,"duration_ms":143}/mem 148013056->162328576

## Verdict

PASS. The merged Console cleanup artifact ran for the full 60-minute window
with 12 on-schedule samples, zero restarts/OOMs/errors, one active writer, healthy
HTTP/API/source/materializer state, successful realtime replay, bounded
authenticated verifier probes, hostile-origin denial, and terminal no-leak.
Scanner ENOENT misses remained classified known noise.

## Rollback Retirement

- Removed the disabled `gitboard.service` user unit and every drop-in after the
  observation PASS; systemd reports `LoadState=not-found`.
- Removed the pre-cleanup `console.service` backup.
- Archived the two local Beads interaction rows from the rollback worktree at
  `/tmp/production-console-interactions-rollback-498da8a.jsonl`, then removed
  `/home/dawid/dev/console/.worktrees/production-console`.
- Kept the exact merged deployment at
  `/home/dawid/dev/console/.worktrees/production-console-cleanup` on commit
  `3f4c40ac70160ada2bc3ad07f355cf7c5ed26b1c`.
- Post-cleanup health remained `200`, owner `apps/console`; the final unit is
  active with zero restarts.
