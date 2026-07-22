# PR63 cgroup file-cache saturation — root-cause attribution

- Bead: `forge-wv9i202091528` (parent epic `forge-wv9i.20.20.9.15`)
- Service: `gitboard.service` (Bun, `apps/gitboard/src/index.ts`)
- PR63 merge: `f0551c8` — "bound verifier and observability materialization"
- Window: 2026-07-22T18:54:47Z → HOLD at T+25 (19:19:47Z)
- Verdict: **expected, reclaimable OS page cache. Not a leak. Gate criteria were invalid.**

## Summary

The T+25 HOLD fired because the deployment gate tested `MemoryCurrent > 1.5 GiB`
alone. `memory.current` climbed 476 MiB → 1.95 GiB (peak touching the 2 GiB
`MemoryMax`). The climb is **entirely reclaimable file page cache** warmed by
bounded SQLite reads against the multi-GiB production databases
(`xtrm.sqlite` ≈ 7.8 GiB on ext4). Anonymous heap stayed flat, no OOM occurred,
the service stayed healthy, and the kernel was already reclaiming the cache at
the cap. The gate measured the wrong quantity.

## Timeline (from `/tmp/forge-wv9i20-pr63-monitor.md`)

| t | memory.current | peak | health | restarts | oom | notes |
|---|---:|---:|---|---:|---:|---|
| T+0 | 477 MiB | 613 MiB | 200 | 0 | 0 | baseline; verifier probe Δ28 MiB, feed probe Δ8 MiB |
| T+5 | 532 MiB | 613 MiB | 200 | 0 | 0 | |
| T+10 | 779 MiB | 788 MiB | 200 | 0 | 0 | |
| T+15 | 1092 MiB | 1094 MiB | 200 | 0 | 0 | feed probe Δ43 MiB, verifier Δ28 MiB |
| T+20 | 1432 MiB | 1499 MiB | 200 | 0 | 0 | |
| T+25 | 1957 MiB | 1980 MiB | 200 | 0 | 0 | **HOLD** (gate: MemoryCurrent > 1.5 GiB) |

Every sample: `journal oom=0 fatal=0 http5xx=0`, `NRestarts=0`, all endpoints
200, specialist-feed latency stable ~0.6–0.9 s.

## Hypotheses tested (one variable at a time)

1. **Anonymous heap leak (unbounded allocation).** ELIMINATED.
   Live `memory.stat anon = 116 MiB`, `MainPID RssAnon = 115.7 MiB`, flat across
   the whole window and across the isolated repro. A leak grows `anon`; it did not.
2. **Accidental full-table/file scan inflating working set.** ELIMINATED as a
   memory fault. Even scan-heavy *bounded* reads (isolated repro steps across the
   whole fixture) keep `anon` flat and only warm reclaimable file cache. PR63
   bounds are present and effective: `EVIDENCE_REFS_PER_EVENT_CAP` /
   `EVIDENCE_REFS_PER_RUN_CAP` (`packages/core/src/materializer/observability-adapter.ts:13-14`),
   bounded forensic backfill (`7eea234`, `82ff854`), bounded feed reads
   (`readSpecialistRows`, `readEvidenceByJob` in `packages/core/src/state/feed-read-model.ts`).
3. **Unreclaimable / pinned memory.** ELIMINATED. `memory.events max=699, oom=0,
   oom_kill=0` — the kernel reclaimed at the cap 699 times with zero OOM. Live,
   `memory.current` later self-dropped 1.53 GiB → 637 MiB with **no restart** as
   the kernel reclaimed ~900 MiB of file cache. Isolated `posix_fadvise(DONTNEED)`
   evicted 100% of the fixture's cached pages.
4. **Expected reclaimable page cache under bounded queries.** CONFIRMED — root cause.

## Exact owner of the growth (live `memory.stat`, cgroup of gitboard.service)

| component | bytes | MiB | reclaimable? |
|---|---:|---:|---|
| `file` (page cache of DB files) | 1,388,122,112 (at 1.53 GiB sample) | ~1323 | **yes** (inactive_file 1.16 GiB) |
| `anon` (heap/stack) | 121,872,384 | 116 | no — but flat & small |
| `slab` | 23,121,360 | 22 | partial |
| `kernel_stack` | 393,216 | 0.4 | — |
| `file_mapped` (mmap) | 929,792 | 0.9 | yes |
| `sock` / `shmem` | 0 | 0 | — |

`memory.current = anon + file + kernel + slab`. The 477 MiB → 1.95 GiB climb is
~100% the `file` term. `file_mapped` is tiny (0.9 MiB) → SQLite is using `read()`
page cache, not large mmap. The page cache belongs to the 7.8 GiB `xtrm.sqlite`
(and the specialists `observability.db`) as bounded queries touch scattered pages;
it is capped by `MemoryMax=2G` and reclaimed there.

## Isolated reproduction (no production DB touched)

`tools/probes/filecache-repro.ts` + `tools/probes/pcprobe.c` (mincore). Generates a
temporary ~469 MiB SQLite fixture **on ext4** (tmpfs cannot model reclaimable
cache), evicts its pages, runs bounded ranged queries across the whole file, and
measures anonymous RSS vs the file's resident page-cache bytes:

```
cold   : file_resident=0.0 MiB    RssAnon=24.4 MiB  VmRSS=63.8 MiB
warm   : file_resident=468.8 MiB  RssAnon=24.2 MiB  VmRSS=64.1 MiB   (rows=61199)
reclaim: file_resident=0.0 MiB    RssAnon=24.3 MiB  VmRSS=64.2 MiB

anon_growth=-0.2 MiB          (bounded working set, flat)
file_cache_growth=468.8 MiB   (reclaimable page cache of the db file)
reclaimed_back=468.8 MiB      (evictable on demand => not a leak)
RESULT: PASS — file-cache growth is reclaimable; anon flat
```

Same signature as production: bounded reads → flat anon, file cache grows toward
the cap, fully reclaimable on demand.

## Before / after memory breakdown

| signal | at HOLD (T+25) | after kernel reclaim (live, no restart) |
|---|---:|---:|
| memory.current | 1957 MiB | 637 MiB |
| anon | ~116 MiB | 115.7 MiB (flat) |
| file | ~1790 MiB | 479.8 MiB |
| memory.events oom / oom_kill | 0 / 0 | 0 / 0 |
| memory.events max | (climbing) | 699 |
| NRestarts / health / latency | 0 / 200 / <1 s | 0 / 200 / 9.5 ms |

## What changed: monitor criteria, not code

No production code changed. PR63 bounds hold (flat anon, oom=0). The fault was the
**gate**. `MemoryCurrent`-only is invalid because it counts reclaimable file cache
and trips on a healthy warm database.

Replacement: `tools/probes/cgroup-health-gate.ts`. PASS requires all of:
1. `memory.events oom == 0` and `oom_kill == 0` (no real OOM);
2. anonymous working set (`memory.stat anon`, cross-checked vs `MainPID RssAnon`)
   under an anon ceiling (default 512 MiB) — the real heap signal;
3. service `ActiveState == active` **and** `SubState == running` (not exited/failed);
4. `MainPID` present and `/proc/<pid>/status` readable (a live process to attribute);
5. optional explicit, deterministic baselines when supplied: `NRestarts ==
   GATE_EXPECT_RESTARTS` and/or `MainPID == GATE_EXPECT_PID` (mismatch fails);
6. `/health == 200` and endpoint latency under a p95 ceiling (optional probes,
   `GATE_PROBE_ENDPOINTS=1`). The health default is portable
   `http://localhost:3030/health`; there is **no hardcoded job feed** — the feed
   endpoint is probed only when `GATE_FEED_URL` is explicitly set, and a non-200
   then fails.

The gate **fails closed**: invalid/non-finite numeric config, a missing
`MainPID`, an unreadable `/proc/<pid>/status`, a non-running substate, or a
baseline mismatch all yield `FAIL`. Each report carries a `checked` list stating
exactly which criteria were evaluated.

File cache near `MemoryMax` is reported as `cache_pressure` **INFO**, never a FAIL,
unless it coincides with `oom>0` or anon over ceiling (genuine saturation).
`MemoryCurrent` is deliberately not a fail criterion. Run live, the corrected gate
returns `PASS` on the same service state that the old gate HOLDed.

## Recommendation

- **No restart, no rollback.** Service is healthy (anon flat, oom=0, health 200,
  NRestarts=0). Restarting would only drop reclaimable cache that re-warms.
- **Do not raise `MemoryMax`** (operator-set 2G cap; out of scope and unnecessary —
  the kernel reclaims within it).
- **Recertify** via a fresh 90-minute absolute-schedule window using
  `cgroup-health-gate.ts` criteria (anon/RSS + oom counters + restarts + endpoint
  latency + cache-pressure INFO) instead of `MemoryCurrent`-only. Record the full
  memory breakdown (`memory.stat anon/file/slab`, `memory.events`, `MainPID` RSS)
  each sample. HOLD only on oom>0, anon over ceiling, restart, or latency/health
  failure.
- Treat the T+25 result as superseded HOLD; the rerun is the gate of record.

## Files

- `tools/probes/pcprobe.c` — mincore file page-cache residency probe (+ `evict`).
- `tools/probes/filecache-repro.ts` — isolated reclaimable-cache reproduction.
- `tools/probes/cgroup-health-gate.ts` — corrected deployment gate (reference).
- `docs/operations/pr63-filecache-attribution.md` — this report.
