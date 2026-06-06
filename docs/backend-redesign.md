# xtrm — Realtime Materialization Refactor

**Status:** Historical redesign spec. Superseded in part by the implemented
post-bridge architecture.
**Scope:** Backend + client realtime spine. Restructures how `xtrm` ingests and serves Beads (issues) and Specialists (agent jobs) data.
**Out of scope:** native substrate engine, issue authoring/write-back, multi-user.

---

> Current-state reference: `docs/backend.md`.
>
> Architectural ownership, telemetry materialization, repo state, and dormant
> tooling reference: `docs/architecture/console-architecture.md`.
>
> This document is preserved because it records the reasoning that led to the
> materializer bridge. Sections that say "current" were written before the
> bridge landed and must be read as historical unless they match the current
> references above. In particular, the current tree no longer has a load-bearing
> top-level `apps/beadboard`, `/api/beads` is not mounted by
> `apps/gitboard/src/api/server.ts`, `/beadboard` is retired/404 by smoke
> contract, and `xtrm.sqlite` plus `materialization_state` now exist.

## 1. TL;DR

Today the `console` side of the app reads its upstream data sources **live on the request path** (Dolt for Beads, per-repo `observability.db` files for Specialists), wrapped in a large degradation machine (circuit breaker, warm-read timeouts, fallback chains, source-health). The `github` side, by contrast, **materializes** the GitHub API into its own SQLite tables and serves from that local copy — and it is the clean, robust part of the system.

This refactor makes `console` converge on the `github` model. A single background **materializer** copies the relevant data from the upstream sources into one owned store (`xtrm.sqlite`), and the API serves **only** from that local copy. Upstream sources remain the source of truth; the local copy is a disposable, rebuildable projection. WebSocket stays a pure invalidation hint; HTTP/local-DB reads are authoritative.

Net effect: one consistency model across the whole app, the degradation machine largely collapses off the hot path, cross-source views/JOINs (e.g. "all specialist jobs in one tab", job↔bead joins) become trivial SQL, and several long-standing structural problems (dual scanners, dual Dolt clients, the `beadboard` cross-app coupling) dissolve as side effects.

---

## 2. Context — current state

- The app currently lives in `apps/gitboard`, served as a single native Bun service, with a Hono HTTP API + static dashboard + WebSocket hub + terminal bridge.
- **github context:** self-contained and gitboard-native. Polls the GitHub API with ETag/304, persists events/PRs/issues/releases into `gitboard.sqlite`, serves from those tables. This is the reference implementation of "materialize and own".
- **console context (Beads + Specialists + graph):** does **not** own its data. It reads live:
  - **Beads** from Dolt (per project), with SQLite/JSONL fallback, behind a circuit breaker.
  - **Specialists** from per-repo `observability.db` SQLite files, via an attach pool, with warm-read timeouts.
- The Beads backend is **imported wholesale from `apps/beadboard`** via relative paths (`../../../beadboard/src/...`). The `beadboard` frontend is deprecated but its backend is load-bearing.
- There are **two project scanners** and **two Dolt clients** (one pair in `beadboard`, one in `gitboard`) that "must be kept aligned" by hand.
- Realtime spine already follows the right core rule: HTTP/DB authoritative, WS as invalidation/sync hint. WS protocol is mature (seq, boot_id, replay buffer, resume, sync_hint on buffer miss). Client side has a shared resource kernel (`resource.ts`) with cache/freshness/fallback/coalesced invalidation, and a `WsClient` with per-channel refcounts.

### 2.1 Known structural debt this refactor addresses

1. **Dual scanner + dual Dolt client.** Both scanners derive the project ID with the same formula (`metadata.project_id || basename(repoPath)` — see `apps/beadboard/src/core/project-scanner.ts:145-151` and `apps/gitboard/src/core/project-scanner.ts:62-75`), so IDs themselves currently align. What diverges in practice: only the gitboard scanner computes `sourceHealth`/`sourcePriority`, the gitboard Dolt client is pool/breaker/probe-heavy while the beadboard client is a single connection (`apps/beadboard/src/core/dolt-client.ts:31-34,179-206` vs `apps/gitboard/src/core/dolt-client.ts:68-70,138-141,224-307`), and the two scanners use different scan scopes/lookup paths. (Their own "Known Sharp Edge #1" — narrowed.)
2. **`beadboard` cross-app coupling.** A deprecated app whose internals a live app reaches into, with no package boundary or contract.
3. **Cache model incoherence.** TTL-based invalidation (graph) and epoch-based invalidation (specialists) coexist, even mixed on the same data (`issueCache` keyed by epochs *and* a 10s TTL).
4. **Warm-timeout conflated with health.** A fixed 750 ms warm timeout returns `stale`/`degraded` even when the source is healthy but merely slow — and interacts badly with the circuit breaker during Dolt slowdowns.
5. **Zombie specialists.** In-flight jobs are read by trusting `LIVE_STATUSES` in `observability.db`; a specialist that dies uncleanly stays "running" forever with no reaper.

---

## 3. Goals and non-goals

### Goals
- One owned, queryable store for everything the dashboard shows.
- One consistency model across `github` and `console`.
- Remove the live-read degradation machine from the request hot path.
- Enable cross-source views, filters, pagination, and joins (notably job↔bead) as ordinary SQL.
- Collapse the dual-scanner / dual-Dolt-client / beadboard-coupling debt as a side effect of the new structure.

### Non-goals (explicitly parked)
- **Substrate as a native issue-tracking engine.** Far-future, complex, uncertain timing. Nothing is designed around it now.
- **Issue authoring / write-back from the UI.** `substrate` is read-only by construction (the only writer is the materializer). If write-back ever happens, it arrives when substrate becomes the native store, not as write-through to Beads.
- **Launching specialists from the UI.** The integrated terminal already covers this. Zero command surface.
- **Multi-user / auth.** Single-user on Tailscale is assumed. The "owned local DB without per-user scoping" model depends on this.

---

## 4. Core principles

1. **HTTP / local DB is authoritative. WebSocket is a hint.** A client can drop every WS message and remain correct, only staler. WS never carries data the client relies on; it is a nudge to refetch.
2. **Materialize, don't project live.** Own a local copy; serve from it. Upstreams are read by a background materializer, never on the request path.
3. **Own the projection, not the truth.** The local copy is authoritative *for reads* but fully rebuildable from upstream. Materialization is one-directional (upstream → local), never write-back. If the local tables are lost, re-materialize from upstream; nothing is lost.
4. **Persist, then broadcast.** A change is written to the local store and committed *before* any WS hint about it is emitted.

---

## 5. Domain model and naming

- **xtrm** — the umbrella app/system. Replaces `agent-forge` as the top-level identity (logs and data move out of `~/.agent-forge/` to under xtrm; `agent-forge` is superseded and not perpetuated).
- **github** — a bounded context. The complete surface for observing/controlling GitHub. Its own materialized tables. Separate peer; can *link* to issues but does not sit on top of them.
- **substrate** — the issue primitive: the owned, normalized read model for the issue + agent world. **It is a group of tables inside the single owned DB `xtrm.sqlite`, not a separate file.** Today its backing source is Beads; a future native engine would be a swappable backing, out of scope.
- **specialists** — agent-orchestration runtime layered over substrate (jobs bound to issues). Materialized from `observability.db`.
- **console** — the **UI shell** that renders github + substrate. It is *not* a data domain. (This was the original naming confusion: `console` is a surface, not a domain.)
- **beads** — the current backing source for substrate (third-party, Dolt/JSONL). Confined behind a materializer adapter. Not a domain in xtrm's vocabulary; an implementation detail of substrate's backing.

### 5.1 Naming consequences
- **DB file:** `gitboard.sqlite` → `xtrm.sqlite`. One file, product-named.
- **Table families:** `github_*`, `substrate_*` (issues/deps), `specialist_*` (jobs/timeline) — or fold specialists into the substrate family; see Open Question Q3-naming. Plus service tables `sources` and `materialization_state`.
- **API namespaces:** one rule. `/api/github/*`, `/api/substrate/*` (issues, and likely graph as a substrate view), `/api/specialists/*` (or nested under substrate), and operational endpoints (terminal, shell, logs, dolt-health) under `/api/internal` (or `/api/ops`) — they are not domains.
- **Collapse the double observability surface:** `/api/specialists/*` and `/api/console/observability/summary` (mounted by `apps/gitboard/src/api/server.ts:98`, routes defined in `apps/gitboard/src/api/routes/observability.ts:10`) are two routers over the same data; keep one.
- **The old `/api/beads` public surface becomes `/api/substrate`** (Beads feeds it; it isn't what you expose).
- **Retire `/beadboard`** only after concrete migration gates clear: remove the iframe fallback in `apps/gitboard/src/dashboard/App.tsx:21-22,135,162-163`, migrate every `/api/beads/*` caller in `apps/gitboard/src/dashboard/lib/beads-api.ts:46-109` onto `/api/substrate/*`, and drop the `apps/beadboard/src/...` relative imports in `apps/gitboard/src/api/server.ts:9,17`. Only then can the compat redirect (`apps/gitboard/src/api/server.ts:125-129`) come out. Today `/beadboard` is a redirect, not dead — it still gates real consumers.
- **Issue ID prefixes (`forge-*`)** are legacy-cosmetic but architecturally inert. The init-time generator is not visible in this repo's source — the scanners only ever consume IDs from `metadata.project_id` or fall back to `basename(repoPath)`. Treat the `forge-*` minting story as an external Beads CLI concern, not an xtrm invariant. **Do not mass-rename them** (see §13.1) — substrate only needs IDs to be stable and unique.

---

## 6. Architecture overview

```
                 ┌─────────────────────────────────────────────┐
  upstreams      │              xtrm (single Bun service)        │
                 │                                               │
  GitHub API ───▶│  github poller ─────┐                         │
                 │                      ▼                         │
  Dolt / JSONL ─▶│  ┌──────────────┐   ┌──────────────┐          │
  (beads)        │  │  watcher(s)   │──▶│  MATERIALIZER │          │
                 │  │  = TRIGGER    │   │  (one writer) │          │
  observability  │  └──────────────┘   └──────┬───────┘          │
  .db (per repo)▶│         ▲                   │ write + commit    │
                 │         │ discovery         ▼                   │
                 │   ┌──────────┐        ┌──────────────┐         │
                 │   │ scanner  │───────▶│  xtrm.sqlite  │         │
                 │   │ (unified)│ sources│  (owned copy) │         │
                 │   └──────────┘  table └──────┬───────┘         │
                 │                               │ read (always)    │
                 │                        ┌──────▼───────┐         │
                 │   emit hint AFTER ─────│  HTTP API     │         │
                 │   commit               └──────┬───────┘         │
                 │         │                      │ authoritative    │
                 │   ┌─────▼─────┐                │                  │
                 │   │  WS hub   │  hint only     │                  │
                 │   └─────┬─────┘                │                  │
                 └─────────┼──────────────────────┼──────────────────┘
                           │ invalidation         │ JSON
                           ▼                      ▼
                 ┌─────────────────────────────────────────────┐
                 │  client: resource kernel + hooks + UI         │
                 │  read local copy → subscribe WS → on hint,    │
                 │  refetch local copy (never trust hint data)   │
                 └─────────────────────────────────────────────┘
```

The pipeline, in one line: **upstream change → watcher triggers → materializer copies the delta into xtrm.sqlite + advances cursor (one transaction) → WS hint → client refetches → API reads local copy → UI updates.**

---

## 7. The owned store — `xtrm.sqlite` (target state)

> **Status:** Not implemented today. This section describes the target architecture. The current request path still reads Dolt + JSONL + per-repo `observability.db` live; there is no `xtrm.sqlite`, no `materialization_state`, and no single writer. References below describe what *will* be created.

One SQLite file, owned and written only by xtrm. WAL mode (concurrent reads during writes; writes serialized). Logical groups:

### 7.1 Data tables (served to the UI)
1. **issues** (`substrate_*`) — work items (Beads). Current state.
2. **dependencies** — issue→issue edges. Drives the graph.
3. **jobs** (`specialist_*`) — specialist runs. Current state.
4. **job→issue link** — which job worked on which issue (the binding). The JOIN that makes "all jobs for a bead" / overlays trivial.
5. **job timeline / events** — append-only ordered progress events per job. The real-time progress surface.

### 7.2 Service tables (used by the materializer, not the UI)
6. **sources** — the registry: which repos/sources exist, their type and paths, discovered vs manual, status. (See §10.)
7. **materialization_state** — per-source cursor and last-run outcome. Source of `freshness` and `source_health` (see §12). Columns (indicative): `source_key`, `cursor`, `last_run_at`, `last_success_at`, `last_status`, `last_error`.

### 7.3 Keys
- Issue IDs are per-repo prefixed and **not guaranteed globally unique** across repos. Use a **composite key** `(source/repo_slug, issue_id)`. Likewise jobs `(repo_slug, job_id)`. (Open Question Q3.)
- Deletes are **tombstones** (`deleted_at`), never hard deletes, to keep the job↔bead JOIN resolvable. (See §8.5.)

### 7.4 State vs events (decided)
The store materializes **current state** for issues and jobs (what the dashboard shows), plus **history only for the per-job timeline** (the events table). Everything else is state, not an event log.

---

## 8. The materializer (target state)

> **Status:** Not implemented today. Current code has watchers and epoch bumpers (`apps/gitboard/src/server/observability/watcher.ts`, `apps/beadboard/src/core/beads-change-watcher.ts`) but no materializer, no single writer, no commit-before-emit invariant. The shape below is the target.

A single background component. One writer to `xtrm.sqlite`. Structured as a **source-agnostic core** plus **per-source adapters**.

### 8.1 Adapter interface
Each source implements three methods:
- `cursor()` — where materialization last reached. Source-specific:
  - **Beads (Dolt + JSONL):** snapshot hash / digest of the last applied per-project snapshot. The Dolt commit hash and JSONL mtime are *coarse skip signals*, not the cursor (see §9.1).
  - **observability.db:** a **pair** — `obs_updated_at_ms` high-watermark for job state and `obs_event_rowid` high-watermark for timeline append (see §9.2). The pair is advanced atomically.
- `changesSince(cursor)` — upserts + deletes since the cursor, **or** the signal "cannot diff, here is a full snapshot".
- `snapshot()` — full current state, for resync and for sources that cannot diff.

### 8.2 Diff strategy
- **Snapshot-diff is the floor.** Any source able to produce its current state can be materialized correctly by diffing snapshot keys against the local copy (→ upserts and deletes).
- **Native diff is the optimization.** When a source supports cheap diffs (Dolt commit/working-set diff), use it.

### 8.3 Correctness invariant (non-negotiable)
The cursor lives **inside `xtrm.sqlite`** (`materialization_state`) and is advanced **in the same transaction** as the applied changes. A mid-run crash never advances the cursor past unapplied data; the next run resumes from the old cursor. **At-least-once delivery + idempotent keyed upsert = effectively-once** on the read model.

### 8.4 Per-source isolation
Each source is materialized independently: its own cursor, its own try/catch, its own `materialization_state` row. A locked `observability.db` or a dead Dolt for one repo must **not** block the others — that source keeps its old cursor and old (stale-but-present) data. This is exactly where `source_health` is populated.

### 8.5 Deletes — tombstone
Real issue deletion is rare (usually close/superseded, not removal). When an issue genuinely disappears upstream, mark `deleted_at` in the local copy rather than removing the row, so specialist jobs referencing that bead don't orphan the JOIN and the UI can show "removed" instead of silently dropping data. Observability jobs are append-oriented and effectively never delete; GC (if ever needed) is handled by full-resync, not the incremental path.

### 8.6 Full-resync
A backstop, not just a bootstrap. Triggered on: first materialization of a source, schema migration, cursor corruption, a slow timer (e.g. hourly — Open Question Q6), and an on-demand button. Reads the full snapshot, upserts all, tombstones any local rows for that source absent from the snapshot. Heals any incremental drift (missed event, bug). **Incremental on every trigger for speed; full-resync periodically for correctness.**

### 8.7 Execution — serialized + coalesced
Process one source at a time via a small queue/worker (SQLite is single-writer anyway; sources are independent, so a queue is predictable and contention-free). Coalesce repeated triggers for the same source (a trigger arriving while the source is already queued is deduped) — reuse the existing `COALESCE_MS` notion.

### 8.8 Emit after commit
The watcher becomes a **trigger only**; it no longer emits WS events directly. The materializer writes + commits, **then** emits the WS hint (carrying source/project/repo + the new cursor for coalesced invalidation). Never emit before commit.

---

## 9. Per-source strategies

### 9.1 Beads / Dolt — Q1 RESOLVED: snapshot-diff floor mandatory
- Versioned; the watcher already polls a hash via `current_commit()` (`apps/beadboard/src/core/dolt-client.ts:167-170`, cached in `apps/beadboard/src/core/beads-change-watcher.ts:71-80`).
- **Evidence from E4 exploration:** there is **no Beads commit path** anywhere in `apps/beadboard/src` — no `DOLT_COMMIT` call, no write path of any kind. The watcher's commit-hash fast-path is reading the HEAD hash of an externally-managed Dolt instance whose write cadence we cannot assume. Commit-diff as a primary cursor is therefore **unsafe** until proven by a live-write probe against the upstream Beads CLI.
- **Therefore:**
  - **Snapshot-diff is the cursor floor**, always. Read the full per-project snapshot (from Dolt when available, JSONL otherwise), diff keys against the local copy, upsert + tombstone.
  - **Working-set hash is an optional fast-path** only if/when upstream exposes a reliable token that advances on every write. Until that exists, treat the commit hash as a *cheap negative signal* (if it didn't change AND we haven't observed mtime changes on `.beads/issues.jsonl`, skip the read) but never as a substitute for snapshot-diff.
  - **JSONL fallback** participates in the snapshot-diff path naturally — the reader returns full project state; the differ handles it the same way.
  - **Deletes** therefore do *not* come for free from a Dolt diff; they fall out of snapshot-diff (key present in local copy, absent from snapshot ⇒ tombstone).
- **Follow-up probe (not blocking implementation):** in a one-off experiment, write an issue via the Beads CLI and observe whether `current_commit()` advances. If it does, the working-set fast-path is viable; if it doesn't, the operator-side Beads CLI is using working-set only and the cursor strategy stays snapshot-diff-only.

### 9.2 observability.db (per repo, SQLite) — Q2 RESOLVED: `updated_at_ms` watermark
- Not versioned (mtime + epoch). Append-oriented for the events side; **mutable for job state**.
- **Evidence from E4 exploration:** `observability.db` is **not** pure event-sourced. The DAO reads current rows directly from `specialist_jobs` (mutable, including `status`) and folds `specialist_events` only for derived turn/tool counts (`apps/gitboard/src/server/observability/dao.ts:26-31,76-105,129-145,190`). The metrics DAO already filters on `COALESCE(m.updated_at_ms, j.updated_at_ms, 0)` (`apps/gitboard/src/server/observability/metrics-dao.ts:92-96`), and the schema guard *requires* `updated_at_ms` on `specialist_jobs` (`apps/gitboard/src/server/observability/schema-guard.ts:1-15`). The attach pool notes "sp writes observability.db constantly" so mtime ticks all the time (`apps/gitboard/src/server/observability/attach-pool.ts:25-27,61-65`).
- **Therefore — cursor strategy:**
  - **Primary cursor = `updated_at_ms` high-watermark on `specialist_jobs`.** On each materialization tick, `SELECT * FROM specialist_jobs WHERE updated_at_ms > :last_watermark` (with a small overlap window to absorb clock skew), upsert into the local copy, advance the watermark to `max(updated_at_ms)` of the batch.
  - **Touched-row re-read** for any job whose `updated_at_ms` slipped past the watermark via the events side: when folding `specialist_events`, collect distinct `job_id`s and re-read those rows from `specialist_jobs` even if their `updated_at_ms` didn't appear in the primary scan.
  - **Events table** is consumed strictly to enrich the per-job timeline and derived counts (turns, tool calls). Cursor on events = max event rowid/seq, but only for timeline append — never as the *job state* cursor.
  - **Deletes** effectively don't occur (jobs accumulate); rely on full-resync for any GC.
- **Why not event-seq for job state:** if a job's `status` flips from `running` → `done` via a direct UPDATE without an accompanying event row, an event-seq cursor would never see it. Reality is exactly this hybrid shape, so `updated_at_ms` is mandatory.

---

## 10. Discovery and the `sources` registry

Discovery answers "which repos/sources exist that should be materialized." It is the explicit **registration** layer (the opposite of fragile filesystem sniffing).

### 10.1 It is a table, not a JSON file
The registry is the `sources` **table** in `xtrm.sqlite`, not a `registry.json`. Reasons: one owned store (no second format/location), transactional, no write race between the refresh button and the periodic refresh, and **JOINable** to materialized data (e.g. "jobs grouped by source, including sources with zero jobs" = LEFT JOIN). *(Exception: if an external tool must read the source list, keep a file but treat it as an import reconciled into the table, never as the runtime registry.)*

### 10.2 Config vs discovered registry — separate them
- **Config** — scan roots (`~/dev`, `~/projects`) plus excludes. Small, hand-authored, fine as a file, git-able. Today the config supports roots/excludes only (see `apps/gitboard/src/server/observability/config.ts:5-19` and `apps/gitboard/src/core/project-scanner.ts:12-18`).
- **Manual pins** — a *new feature* this refactor introduces. There is no manual-pin registry today; the scanners only honor config roots and excludes. The `sources` table is where pins live, with `origin = manual` distinguishing them from discovered rows.
- **Discovered registry** — machine output of what was found and its state. The `sources` table.
- The settings-tab button acts on config and *triggers* a scan; the discovered list is the table. Keeping both in one regenerated JSON would clobber manual edits.

### 10.3 Refresh = reconcile, not overwrite
On refresh: upsert discovered sources, **preserve** manually-pinned ones, and mark **missing** (don't delete) sources no longer found — so a vanished repo's historical materialized data is still shown. Columns: `origin` (`discovered | manual`), `status` (incl. `missing`).

### 10.4 Triggers
- Periodic, low cadence (repos appear rarely).
- On-demand button ("I just created a repo, pick it up now").
- Optional: the existing observability watcher already watches parent directories for mtime; it can signal a new `.beads`/`observability.db` appearing and auto-trigger discovery. Keep optional; periodic + button is more predictable.

### 10.5 Single unified scanner
The `sources` table is the **single output of one unified scanner**, replacing the two scanners (and one unified Dolt client replacing the two). This is how structural debt #1 dissolves: one scanner → one table → one source-health computation.

---

## 11. Realtime delivery

### 11.1 Server
- **Actual current channel registry** (`apps/gitboard/src/api/ws/channels.ts:3-12`) is broader than the original draft implied:
  ```
  github:activity            github:repo:${string}
  beads:changes              beads:project:${string}
  specialists:activity       specialists:repo:${string}
  session:${string}          output:${string}
  messages                   protocol:${string}
  system
  ```
  Note: log fanout is on channel `system` (not `system:logs`) per `apps/gitboard/src/core/logger.ts:22-29`, and the terminal WebSocket uses a separate upgrade path (`apps/gitboard/src/api/server.ts:172-199`), not a registry channel.
- **Rename plan under new naming:** `beads:* → substrate:*` (both the singleton `beads:changes` and the per-project `beads:project:${id}` channels). All other channel families keep their current names.
- Keep the existing mature protocol: per-channel `seq`, `boot_id`, replay buffer = `RING_BUFFER_SIZE = 500` (`apps/gitboard/src/api/ws/channels.ts:39-45`), `resume`, and `*:sync_hint` on buffer miss / `boot_id` mismatch (`apps/gitboard/src/api/ws/handler.ts:74-88`).
- **Emit point moves to post-commit** (see §8.8). Persist-then-broadcast literally. Today's GitHub poller and beads watcher already upsert/snapshot before publishing (`apps/gitboard/src/core/github-poller.ts:462-578`; `apps/beadboard/src/core/beads-change-watcher.ts:91-124,164-224`) — no publish-before-persist bug was found in current code. The materializer formalizes this as a same-transaction commit + emit invariant.

### 11.2 Client
- **Q7 RESOLVED:** keep the **resource kernel** (`apps/gitboard/src/dashboard/lib/resource.ts:33-220`): cache by key, freshness, last-successful fallback, abort, focus/visibility refresh, polling fallback, forced refresh, coalesced WS invalidation. Hooks remain thin selectors over it. Migrating to TanStack Query / SWR would still require rebuilding the WS-invalidation adapter, delta-apply, and last-success fallback glue — net work without functional gain.
- Keep **per-channel refcounts** on `WsClient` (`apps/gitboard/src/dashboard/lib/ws.ts:113-131`); **add a small grace period** before dropping to zero (no such timer today — `apps/gitboard/src/dashboard/hooks/useWebSocket.ts:5-33` unsubscribes immediately on cleanup) to avoid unsubscribe/resubscribe churn on fast unmount/remount.
- On open: read the local copy via the API (instant first paint, never blank) → subscribe WS → apply hints as invalidations (refetch from the local copy). Optionally a one-shot refresh nudge on open to tighten staleness.
- **Hook-usage caveat:** today's hooks are *not* uniformly invalidation-only. `useGraphData`, `useChains`, and the `beads:sync_hint` path in `BeadsRepoView` already treat WS as invalidation hints; `useGithubActivity` and `useSystemLogs` treat WS as live data streams; `BeadsRepoView` is hybrid (applies `beads:*` deltas in addition to coalesced refetches). The refactor's "WS as hint only" rule applies to substrate/specialists hooks — the live-data hooks (logs, terminal, transient telemetry) keep their current shape because the underlying data is not in `xtrm.sqlite`.

---

## 12. Freshness and source_health (two orthogonal axes)

Materialization disambiguates the two axes that previously shared vocabulary:
- **freshness** = age of the materialized data (`now - last_success_at`). A property of the local copy.
- **source_health** = outcome of the materializer's last sync attempt for a source (`materialization_state.last_status`). A property of the upstream/materializer.

Both are **derived from `materialization_state`**, not computed ad hoc across the codebase. A source can be `source_health: degraded` (last sync failed) while the served data is still recent — and the UI can express that combination, which the old fused vocabulary could not. Warm-read timeouts largely leave the hot path (reads hit the local copy), so "slow source ⇒ stale" no longer happens per request.

---

## 13. End-to-end flow (single copy) — target state

> **Status:** Future flow. Today the request path is still live Dolt + JSONL + observability.db attach pool with 750ms warm timeout (`apps/beadboard/src/api/routes/beads.ts:254-387`, `apps/gitboard/src/core/graph-dao.ts:284-309`, `apps/gitboard/src/api/routes/specialists.ts:66-127`). The flow below describes the target after the materializer lands.



Example: a specialist working on bead `forge-x` completes a step.

1. **Source changes** — the agent writes a new event row to its `observability.db`. xtrm doesn't know yet.
2. **Watcher notices** — the file's mtime changed; it emits a *trigger* ("repo X changed"), reads no data, enqueues.
3. **Materializer copies the delta** — reads `materialization_state` for the pair `(obs_updated_at_ms, obs_event_rowid)`. Selects `specialist_jobs` rows where `updated_at_ms > obs_updated_at_ms` (with a small overlap window) and upserts them; selects `specialist_events` rows where `rowid > obs_event_rowid` and appends them to the timeline; runs a touched-row re-read for any `job_id` seen on the events side that wasn't already picked up by the job-state scan. Job state comes from the mutable `specialist_jobs` rows, not from folding events.
4. **Write + commit** — updates the job row and appends timeline events, advances the watermark, in **one transaction**.
5. **Emit WS hint** — only now, after commit: "specialists for repo X changed".
6. **Client refetches** — treats the hint as a wakeup, not data; asks the API.
7. **API reads the local copy** — `xtrm.sqlite`, already updated, fast, never fails; returns it; UI updates.

Cold open is the same minus the trigger: the client reads the local copy immediately and subscribes WS. Beads is identical in shape except the source is Dolt (with JSONL fallback) and "what changed" comes from a **snapshot-diff** against the local copy (per §9.1). The Dolt commit hash is at most a *coarse negative skip signal* — and only when JSONL mtime is also unchanged — never the actual cursor.

Two guarantees that fall out: the API **never** reads upstreams live (a down/slow source can't hang or blank the screen — worst case the copy is slightly stale), and the WS message carries no relied-upon data (lose it / reconnect / reload — you always recover from the local copy).

### 13.1 Issue-ID note
Issue IDs are a **cross-system foreign key** shared between Beads and `observability.db` (the job↔bead binding). A prefix rename in Beads alone would desync the binding (and git artifacts). Do not mass-rename; treat existing IDs as immutable. The mint-time generator lives in the external Beads CLI, not in this repo's source — controlling new prefixes is therefore an upstream concern, not something xtrm decides.

---

## 14. Failure modes — target guarantees

> **Status:** Today's code already delivers some of these (Dolt → JSONL fallback, stale timeout, `boot_id` and replay buffer on the WS spine: `apps/gitboard/src/api/ws/channels.ts:39-45,90-110`). The materializer-related rows (mid-run crash semantics, "data goes stale, not blank") are *target acceptance criteria* for the new pipeline, not current guarantees.



| Scenario | Behavior |
|---|---|
| Upstream source down/slow | Reads still served from local copy; that source's `materialization_state.last_status` reflects failure; data goes stale, not blank. |
| WS hint lost / client reconnect | Client refetches local copy; replay buffer / `sync_hint` covers gaps. No reliance on unbroken stream. |
| Materializer crash mid-run | Cursor not advanced (same-tx invariant); next trigger resumes; idempotent upsert makes re-apply safe. |
| Large upstream batch | Overflow → `sync_hint` instead of flooding events; client refetches. |
| Server restart | `boot_id` change signals clients to resync; full state is in the local copy. |
| Zombie specialist (died unclean) | See §15 — derive "suspected-dead" from `last_event_at` staleness; do not blindly trust `LIVE_STATUSES`. |

---

## 15. Zombie specialist handling

`observability.db` is owned by `sp`; xtrm cannot fix terminal state upstream. But because the job state is now **materialized into a table xtrm owns**, the materializer can derive a `suspected_dead` flag from `last_event_at` staleness (no event in N minutes on a live status) and surface it in the UI, instead of showing a forever-"running" chip. (Threshold and whether it's computed at materialization or query time: Open Question Q5.)

---

## 16. Structural cleanups (bundled with this refactor)

These follow the staged sequencing in §18. None are urgent enough to mix into the materializer landing.

- **Late:** Rename `gitboard.sqlite` → `xtrm.sqlite`; consolidate table families. Sequenced last (§18 step 11) — renames mid-refactor compound merge risk.
- **Mid:** Extract shared Beads/Dolt/watcher/scanner code into `packages/beads-core`; xtrm depends on the package, not on `apps/beadboard` internals. **Delete `apps/beadboard` only after** the iframe fallback in `App.tsx`, the `/api/beads/*` calls in `beads-api.ts`, and the relative imports in `server.ts:9,17` are all gone (see §5.1 / §18 step 10). The beadboard *frontend* is deprecated, but the backend is load-bearing today.
- Collapse two scanners → one; two Dolt clients → one. The scanner-divergence story is narrower than originally claimed (IDs already align — see §2.1), so the win is consolidation and source-health uniformity rather than fixing an ID-divergence bug.
- Rationalize API namespaces (one rule); collapse the double observability surface (`/api/specialists/*` and `/api/console/observability/summary` are two routers over the same data).
- Move logs out of `~/.agent-forge/` to under xtrm's data dir / `~/.xtrm/`.
- **Late:** Retire `/beadboard` compat redirect — only when the consumer count is zero (§18 step 10).
- Migrate cache invalidation toward epoch/version everywhere; demote TTL to a long safety-net role, not a primary freshness mechanism.
- **Late:** Code dir `apps/gitboard` → `apps/xtrm`. Noisier refactor; follows after behavior is stable.

---

## 17. Open technical questions (must resolve before/at implementation)

> These are deliberately unanswered; each gates a concrete implementation choice.

- **Q1 — Beads commit cadence. RESOLVED (E4).** No commit path in `apps/beadboard/src`; the watcher reads `current_commit()` HEAD and caches it. → **Cursor = snapshot-diff floor** (mandatory). Commit hash usable only as a cheap *negative* signal; working-set hash only as an optional fast-path if upstream proves writes advance it. See §9.1.
- **Q2 — observability.db shape. RESOLVED (E4).** Hybrid: mutable `specialist_jobs` rows + side-table `specialist_events`; `updated_at_ms` column already present and used by the metrics DAO. → **Cursor = `updated_at_ms` high-watermark + touched-row re-read.** Event-seq only for timeline append. See §9.2.
- **Q3 — unified key.** Confirm composite keys `(repo_slug, issue_id)` and `(repo_slug, job_id)` given per-repo auto-prefixed IDs aren't globally unique.
- **Q3-naming — table families.** Fold specialists into `substrate_*` or keep a separate `specialist_*` family?
- **Q4 — graph boundary.** Is the graph a *view* over substrate (issues + deps + specialist overlay) or its own primitive? (Leaning: view.)
- **Q5 — zombie reaping.** Staleness threshold for `suspected_dead`, and computed at materialization time vs query time?
- **Q6 — resync cadence.** Full-resync on a slow timer (hourly?) + on-demand, or on-demand only?
- **Q7 — client cache layer. RESOLVED (E3).** Keep `resource.ts`; add a `WsClient` zero-drop grace timer as a small follow-up. TanStack/SWR would still need custom WS-invalidation, delta-apply, and last-success fallback glue — net work without functional gain. See §11.2.
- **Q8 — github↔substrate linking.** Do we want PR/commit ↔ issue links? If yes, an explicit relation + a derivation rule are needed.
- **Q9 — cold-start materialization.** Lazy on first access + background fill, or eager at boot across all sources?
- **Q10 — tombstone retention.** How long do tombstoned issues live before GC, if ever?

---

## 18. Suggested sequencing (revised after E1-E4 + overthinker synthesis)

The original sequencing assumed Q1/Q2/Q7 were open and that the dual-scanner / `/beadboard` debt could be dissolved in one pass. The revised sequence treats the materializer as a **shadow build** that runs alongside current code, with renames and beadboard retirement deferred until parity is proven.

1. **Patch this spec first.** Apply the edits in §§2.1, 5.1, 7-9, 10.2, 11, 13, 13.1, 14, 16, 17 (above) before any executor starts. Resolve Q1/Q2/Q7 inline as done; keep Q3/Q5/Q6/Q8/Q9/Q10 as implementation choices, not approval blockers.
2. **Define the schema and invariants.** New tables go into a brand-new file **`xtrm.sqlite`**, created in the same `GITBOARD_DATA_DIR` *alongside* the existing `gitboard.sqlite` (which keeps owning the `github_*` tables for the duration of the refactor). The two files coexist; step 11 folds them. Define data + `sources` + `materialization_state` tables. Composite keys `(repo_slug, issue_id)` and `(repo_slug, job_id)` per Q3. Tombstones (`deleted_at`). Cursor columns explicitly typed, **per source**:
   - Beads: `beads_snapshot_hash` (digest of last applied snapshot).
   - observability: the **pair** `(obs_updated_at_ms, obs_event_rowid)`, advanced atomically in the same transaction as the data writes (per §9.2 / §8.1).
3. **Build materializer core in shadow mode.** One writer, serialized queue, same-transaction cursor advance, idempotent upserts, per-source try/catch. Writes to `xtrm.sqlite` happen; the API does **not** read from it yet. This stage proves the writer is correct without changing user-visible behavior.
4. **Implement the observability adapter first** — simpler shape, `updated_at_ms` watermark + touched-row re-read (per §9.2). Run it continuously; compare its output to the current `/api/specialists/*` responses (parity diff in logs or a debug endpoint).
5. **Flip the specialists read path to the local copy.** Emit WS only after commit. Derive `freshness`/`source_health` from `materialization_state`. Keep the old attach-pool path behind a fallback flag until parity holds for at least one full daily cycle in production.
6. **Implement the Beads adapter with snapshot-diff floor** (per §9.1). JSONL participates naturally. Commit-hash usable only as a *negative* fast-path; working-set fast-path is contingent on the upstream-probe follow-up.
7. **Add the unified scanner writing `sources`.** Start with roots/excludes parity so today's discovery behavior is preserved exactly. Dual-run old scanners alongside until the source list matches. Manual pins land here as an explicit new feature (per §10.2).
8. **Repoint graph and substrate APIs to the local copy.** Keep `/api/beads/*` mounted as a compatibility surface during client migration. `/api/substrate/*` becomes the authoritative public surface.
9. **Client migration.** Hooks repointed to new surfaces; channel rename `beads:* → substrate:*` happens here in lockstep with subscriptions. Add the `WsClient` zero-drop grace timer (per §11.2). Keep `resource.ts`.
10. **Retire `/beadboard` only when the dependency count is zero.** Remove the iframe fallback in `App.tsx`, migrate every `/api/beads/*` call in `beads-api.ts`, drop the relative-import bridge in `server.ts:9,17`. Only then remove the compat redirect.
11. **Renames last & file consolidation.** Fold the `github_*` tables from `gitboard.sqlite` into `xtrm.sqlite` (single owned file, as §7 envisions); remove `gitboard.sqlite`. Do the namespace cleanup, log-dir move out of `~/.agent-forge/`, and `apps/gitboard → apps/xtrm` directory rename. All of this comes *after* behavior is stable, tests are green, and beadboard is fully retired. Renaming mid-refactor compounds merge risk for no behavioral gain.

**This-week scope.** Apply the spec patches; build the schema + shadow observability materializer (steps 1-4 only). Do **not** rename anything, touch the Beads adapter, or remove beadboard yet.
