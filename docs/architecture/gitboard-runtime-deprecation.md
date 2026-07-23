---
version: 1
updated: 2026-07-04
synced_at: ffe1e17
---

# Gitboard Runtime Deprecation Map

Status: runtime deprecation plan for `forge-3dm4`; `forge-6oae` closed the safe deprecation wave, but `apps/gitboard` still owns compatibility wrappers until bridge-retirement gates pass.

`apps/gitboard` is still the live compatibility host. Implemented now: thin HTTP compatibility surface, app startup glue, and the completed core-owned slices listed below. Target state: remove runtime ownership from the app so database schema, materializer lifecycle, read-model SQL, source lifecycle, and durable GitHub adapter state live in `packages/core`.

Planning evidence for this map came from explorer jobs 6bf419, 9e9619, ef1241 and the closed `forge-3dm4`/`forge-6oae` notes. It does not claim failed Kimi prep jobs.

The typed source of truth for this map is
`packages/core/src/runtime/ownership.ts`.

### forge-3dm4.3 source-lifecycle slice

Moved to `@xtrm/core/runtime`:
- source path redaction helper
- refresh cooldown gate / refresh state helper
- missing-source reconciliation decision helper
- refresh summary payload helper
- watcher unchanged-commit skip decision + source-health payload helper

Still app-owned in `apps/gitboard`:
- `ProjectScanner` traversal and cache
- `UnifiedScanner` filesystem/DB orchestration and SQL updates
- `BeadsChangeWatcher` fs.watch, timers, Dolt reads, and publish plumbing
- HTTP route mounting and compatibility wrappers

This slice does not remove `ProjectScanner` or change public DTOs.

### forge-3dm4.5 realtime/log runtime slice

Moved to `@xtrm/core/runtime`:
- realtime protocol version constant
- channel-name, message, envelope, subscriber, and registry contracts
- log level/component/entry contracts
- `makeLogEntry` construction helper
- logger runtime ring, subscriptions, level filtering, disk retention/write queue, and optional publisher hook

Still app-owned in `apps/gitboard`:
- `ChannelRegistry` implementation and replay ring buffers
- `WsHandler` connection, subscribe, unsubscribe, resume, and Bun adapter glue
- logger compatibility singleton, env-derived log paths, legacy symlink policy, and ChannelRegistry publisher adaptation
- internal log HTTP routes and request timing/error/slow log emitters

This slice does not move Bun websocket upgrades to the daemon and does not
change websocket envelope fields, replay behavior, internal log DTOs, or log
entry shapes.

### forge-3dm4.6 terminal/shell policy contract slice

Moved to `@xtrm/core/terminal/policy`:
- shell provider policy/status/access context contracts
- shell-capable provider kind and readonly/shell permission helpers
- shell provider env parsing and enabled/disabled decision helpers
- shell websocket path/origin and admin-token verification helpers

Still app-owned in `apps/gitboard`:
- `TerminalBridge` connection, attach, detach, input, resize, exit, and cleanup state
- local PTY spawning, filesystem realpath checks, timers, input/output budgets, and process cleanup
- specialist-feed process wiring and route DTO adapters
- Bun websocket upgrade glue in `startServer`

This slice does not broaden verified-admin, origin, cwd, shell, env, rate,
TTL, or readonly specialist-feed behavior.

### Lifecycle Summary

Implemented now:
- `apps/gitboard` remains live compatibility host.
- `forge-6oae` slices in this doc are complete.
- `createGitboardRuntimeOwnershipMap` and `createGitboardFinalRuntimeMigrationPlan` define current ownership and next migration plan.

Target state:
- daemon-owned runtime, core-owned read models and adapters, and thin app wrapper only.

Blocked:
- wrapper deletion, static/socket/service retirement, and `ProjectScanner` extraction stay blocked until parity, smoke, and manual restart evidence exists.

Bridge-retirement gate:
- current probe is retain-only; it is not wrapper cleanup.

### forge-3dm4.8 bridge-retirement gate

No compatibility wrapper is removed in this gate. The bridge-retirement probe currently returns `ready: false`, `action: retain`, with missing daemon-served contracts:
- `feed.rollups`
- `graph.console-joins`
- `source-health.freshness`

Retained wrappers:
- `createApp` and `startServer` compatibility wrappers
- app HTTP route DTO adapters for public `/api/*`
- Bun WebSocket upgrade adapters, `ChannelRegistry`, `WsHandler`, and log ring
- `TerminalBridge`, local PTY/provider wiring, and shell route adapters
- static `/console` and `/gitboard` mounts
- host-local `gitboard.service` compatibility alias
- durable GitHub adapter tables and route state

This documents the current bridge-retirement gate through `forge-3dm4.8` while preserving compatibility. Wrapper deletion requires daemon-served replacements, route/static/socket parity, smoke evidence, and manual production restart evidence.

## Target Runtime

The replacement runtime owner is `@xtrm/core/runtime`, with `xt daemon` as the
native service target for state/socket ownership. `apps/gitboard` remains only a
compatibility host while the final migration is underway:

- mounted HTTP adapters for existing `/api/*` routes;
- static serving for `/console` and `/gitboard`;
- Bun websocket upgrade glue until the daemon owns the socket boundary;
- `gitboard.service` compatibility until the service/static retirement gate
  passes.

`apps/console` remains UI/read-query only and must not open SQLite or own
runtime writes.

## Architecture Docs Gate

Every `forge-6oae` runtime migration bead must update this document in the same
branch as its code change. The update must record:

- migrated surface;
- new `packages/core` owner/export;
- remaining `apps/gitboard` compatibility wrapper;
- test/build/smoke gates that passed;
- residual risk or reason the surface is not fully deprecated yet.

When a bead changes read-model, bridge retirement, source-health, feed, graph,
or specialist evidence semantics, it must also update
`docs/architecture/daemon-read-model-contract.md`.

Do not close a migration bead unless code and architecture docs agree. If a
bead intentionally has no architecture-doc delta, its closure reason must say
why.

## Ready Front

The safe first implementation front is:

- `xtrm-state-schema` (`forge-6oae.2`) — move `createXtrmDatabase` ownership to
  `@xtrm/core/state` while keeping the app wrapper.
- `runtime-host` (`forge-6oae.3`) — introduce `@xtrm/core/runtime` host
  contracts while keeping `createApp` and `startServer` compatible.

Only after those two are complete should the materializer, read-model, source
lifecycle, and GitHub adapter slices move.

## Runtime Surfaces

| Surface | Current state | Core owner/export | Remaining app wrapper | Gate |
|---|---|---|---|---|
| `xtrm-state-schema` | Core-owned as of `forge-6oae.2` | `@xtrm/core/state/database` | `apps/gitboard/src/core/xtrm-store.ts` re-exports core schema API | Existing schema/materializer/API tests and direct Bun DB probe passed |
| `runtime-host` | Core contract defined as of `forge-6oae.3` | `@xtrm/core/runtime` | `apps/gitboard/src/api/server.ts` still mounts routes and starts watchers | Host descriptor tests, route tests, typecheck, and local staging smoke passed |
| `materializer-runtime` | Core-owned as of `forge-6oae.4` | `@xtrm/core/materializer` | `apps/gitboard/src/core/materializer/index.ts` injects gitboard logger and observability epoch hooks | Core materializer tests, app materializer tests, typecheck/build, and staging smoke passed |
| `console-read-models` | Feed rollup core-owned as of `forge-6oae.5`; substrate, specialists, graph, and source-health query code still pending | `@xtrm/core/state` | `apps/gitboard/src/api/routes/feed.ts` is an HTTP adapter over `readFeedPage`; other app routes still own their current SQL/query wrappers | Feed route/API parity, core feed service tests, typecheck/build, and staging smoke passed |
| `source-lifecycle` | Source-health vocabulary/helper core-owned as of `forge-6oae.13`; scanner/watcher runtime still app-owned | `@xtrm/core/runtime` and `@xtrm/core/state` | `apps/gitboard/src/types/source-health.ts` re-exports core source-health; `apps/gitboard` still owns `ProjectScanner`, `UnifiedScanner`, source routes, and watchers | Source-health parity tests, source/API tests, typecheck/build, and staging smoke passed |
| `github-adapter` | Durable GitHub store, DB factory, poller, discovery, readme, and GitHub route runtime all core-owned as of `forge-3dm4.4`. Core ports: `GithubActivityPublisher`, `GithubAdapterLogger`. | `@xtrm/core/github` (includes `poller.ts`, `discover.ts`, `readme.ts`, `token.ts`, `ports.ts`) | `apps/gitboard/src/core/github-poller.ts`, `github-discover.ts`, `github-readme.ts`, and `github-store.ts` are thin re-export/injection shims that wire app-side logger + channel registry into the core ports. App routes and startup still mount poller and routes. | Core owns GitHub runtime adapter orchestration; app startup and routes preserve current behavior and DTOs; SKIP_GITHUB_POLLER still honored; ETag/304, rate-limit handling, backfill/poll logs, source-health updates, and websocket publish behavior preserved |
| `realtime-log-delivery` | Realtime/log protocol contracts and reusable logger runtime core-owned as of `forge-3dm4.5`/`forge-lq2z3`; websocket implementations still app-owned | `@xtrm/core/runtime` (`realtime.ts`, `logs.ts`, `log-store.ts`) | `apps/gitboard` keeps `ChannelRegistry`, `WsHandler`, Bun upgrades, internal log routes, and a thin logger singleton that adapts env paths plus ChannelRegistry publish | Websocket protocol/replay tests, core runtime logger tests, internal log route tests, logger wrapper tests, typecheck, GitNexus, and staging smoke pass or are classified before close |
| `terminal-shell-boundary` | Console-owned as of `forge-wv9i.7`; core owns host-neutral policy/provider contracts and Console owns Bun upgrades, bridge, route DTOs, helper injection, and shutdown | `@xtrm/core/terminal/*` plus `apps/console/src/server/terminal/**` | `apps/gitboard/src/api/terminal/provider-registry.ts` injects only the rollback host helper until Phase 8 deletion | Exact WS paths, verified-admin/origin/loopback gates, cwd/shell allowlists, env scrub, live-child cap, rate limits, hard/idle TTL, readonly feed, and no-leak PTY smoke pass |
| `service-static-retirement` | `gitboard.service` documented as a host-local compatibility alias as of `forge-3dm4.7`; `/console` and `/gitboard` still hosted by the app entrypoint | `@xtrm/core/runtime` daemon unit replacement after gates | `apps/gitboard` stays as service/static compatibility alias using `bun --cwd apps/gitboard src/index.ts` until final gate | Static p9 smoke, deprecation smoke, deployment docs, and wrapper checklist all green |

## Final Child Beads

These are the required `forge-3dm4` implementation children, in dependency
order. Each child must update this document in the same branch as its code
change and record the tests/smoke evidence that passed.

| Order | Child | Depends on | Surfaces | Required impact targets | Validation gate |
|---:|---|---|---|---|---|
| 1 | Plan/document final runtime boundary | none | compatibility shell | `createApp`, `startServer` | runtime ownership tests and docs agree |
| 2 | Move remaining Console read-model services to core | 1 | `console-read-models` | `createSubstrateRouter`, `createSpecialistsRouter`, `createGraphDao`, `createSourcesRouter` | route-to-core DTO parity and targeted route tests |
| 3 | Extract scanner/watchers/source lifecycle | 2 | `source-lifecycle` | `ProjectScanner`, `UnifiedScanner`, `BeadsChangeWatcher` | source parity, graph/source tests, attach/skip log smoke |
| 4 | Move GitHub poller/discovery/readme runtime hooks | 1 | `github-adapter` | `GithubPoller`, `discoverAndInsert`, `getGithubToken` | GitHub poller/route tests and poller-enabled smoke tier (core `github-poller.test.ts` 10 tests, gitboard `github-poller.test.ts`/`github-poller-loop.test.ts`/`github-discover.test.ts`/`github.test.ts`/`github-detail-cache.test.ts`/`github-releases.test.ts` 60 tests pass; `packages/core` tsc clean) |
| 5 | Move runtime host, websocket, and log delivery contracts | 2, 4 | `runtime-host`, `realtime-log-delivery` | `createApp`, `startServer`, `ChannelRegistry`, `WsHandler`, `emit` | runtime host, realtime contract, and internal log tests |
| 6 | Move terminal/shell safety boundary contracts | 5 | `terminal-shell-boundary` | `TerminalBridge`, `parseShellProviderPolicy`, `LocalPtyProvider` | terminal provider, shell policy, and denial/allowance probes |
| 7 | Turn service/static host into compatibility wrapper | 3, 5, 6 | `service-static-retirement` | `startServer` if server code changes; `createGitboardRuntimeOwnershipMap` for metadata | production-ready static smoke, deprecation smoke, deployment docs |
| 8 | Retire obsolete wrappers | 7 | compatibility shell cleanup | `evaluateBridgeRetirementReadiness`, `createGitboardRuntimeOwnershipMap`; `createApp`/`startServer` only if deleting wrappers | bridge readiness says retain; GitNexus detect-changes, static smoke, deprecation smoke evidence recorded |

`ProjectScanner` is a CRITICAL impact target: current graph impact reaches
source routes, graph DAO/cache invalidation, parity, `createApp`, Beads watcher,
and `UnifiedScanner` flows. Keep that extraction isolated and do not combine it
with route cleanup or service/static retirement.

## Smoke And Production Gates

The final migration requires three smoke tiers:

1. Isolated deprecation smoke:
   `bun run --cwd apps/gitboard smoke:deprecation`.
   Evidence: health/API probes, `materializer.run`, `materializer.publishHint`,
   `channel.publish`, and no materializer/API errors.
2. GitHub poller-enabled smoke:
   run without `SKIP_GITHUB_POLLER=1` or explicitly classify unavailable
   credentials. Evidence: GitHub auth/token path, poller cycle/backfill logs,
   GitHub route probes, and rate-limit behavior unchanged.
3. Production restart smoke:
   manual `gitboard.service` restart only after local/staging evidence.
   Evidence: tailnet health/API probes, websocket/log probe, and
   materializer/channel logs flowing.

`forge-3dm4.7` keeps production restart manual and documents the current
host-local service as a compatibility alias:
`ExecStart=bun --cwd apps/gitboard src/index.ts`. Roll back by keeping that
unit/env unchanged until the future core daemon unit replacement has its own
static, API, WebSocket/log, terminal, and materializer evidence.

## Wrapper Retirement Checklist

Current state: blocked. Do not delete or collapse an app wrapper unless all of these are true:

- the current public route remains mounted or has a replacement route with
  parity tests;
- Console remains UI/read-query only and never opens SQLite;
- bridge retirement readiness is true for all daemon-served Console contracts;
- GitHub durable adapter state is retained and not treated as temporary bridge
  data;
- WebSocket, terminal, and static route compatibility probes pass;
- `gitboard.service` is a documented compatibility alias with rollback to the
  current Bun app entrypoint;
- `npx gitnexus detect-changes` or the MCP equivalent reports only expected
  symbols and flows.

Current `forge-3dm4.8` status:

| Checklist item | Status | Evidence |
|---|---|---|
| Public route mounted or replaced with parity tests | PASS | No public route removed; deprecation smoke probes `/api/*` compatibility |
| Console remains UI/read-query only | PASS | No `apps/console` runtime write path added |
| Bridge retirement readiness true | PARTIAL | `evaluateBridgeRetirementReadiness` returns `retain`; missing `feed.rollups`, `graph.console-joins`, `source-health.freshness` |
| GitHub adapter state retained | PASS | Durable GitHub state remains retained and outside bridge cleanup |
| WebSocket, terminal, static probes pass | PARTIAL | Static p9 and deprecation smoke pass; daemon-owned socket/terminal replacement not yet complete |
| gitboard.service compatibility alias documented | PASS | `.7` documents rollback to current Bun app entrypoint |
| GitNexus expected-scope report | PASS | `.8` detect-changes records docs/metadata-only scope |

## GitHub Adapter Current State

| Layer | Owner | Notes |
|---|---|---|
| Durable store functions, DTOs, and legacy DB factory | `@xtrm/core/github` | Covers events, commits, repos, poll state, PRs, issues, releases, repo stats, contribution summaries, commit-message enrichment helpers, and the legacy GitHub/session/specialist-events schema used by GitHub route tests. |
| Compatibility import paths | `apps/gitboard/src/core/github-store.ts`, `apps/gitboard/src/core/store.ts` | Pure re-exports for existing route, poller, and tests. |
| Runtime poll loop | `apps/gitboard` | Still owns channel publish, source-health updates, logger entries, token discovery, and `SKIP_GITHUB_POLLER=1` startup behavior. |
| HTTP route DTOs | `apps/gitboard` | `/api/github/*` stays mounted and keeps response shapes while reading through the store wrapper. |

## Completed Slices

| Bead | Surface | Validation | Residual risk |
|---|---|---|---|
| `forge-6oae.1` | Runtime ownership map | `packages/core` runtime ownership tests, lint/build, diff check, GitNexus LOW | Planning surface only; no runtime moved |
| `forge-6oae.2` | `xtrm-state-schema` | Core package lint/build, app schema/materializer/API tests, direct Bun DB probe for 17 tables, diff check | `bun:sqlite` remains a Bun-only import, exposed through explicit `@xtrm/core/state/database` subpath |
| `forge-6oae.3` | `runtime-host` | Core host tests, app route tests, gitboard typecheck, package build, staging smoke on port 3099 with zero materializer/request errors | `createApp` still owns route mounting and watcher startup until later slices |
| `forge-6oae.4` | `materializer-runtime` | Core materializer export tests, gitboard materializer/adapter tests, package build, gitboard typecheck, staging smoke on port 3099 with materializer/log filters | Beads and observability adapters remain app-owned until source/read-model extraction beads |
| `forge-6oae.5` | `feed.rollups` read model | Core feed read-model tests, `/api/feed` route parity tests, API gate suite, package build, gitboard typecheck, staging smoke on port 3099, diff check, GitNexus detect-changes | Substrate, Specialists, graph, and source-health read models still need their own core services; `/api/feed` keeps reading bridge tables until daemon read models are live |
| `forge-6oae.9` | Runtime extraction contract tests for schema/materializer/runtime host | Core state/runtime/materializer tests, app wrapper contract tests, gitboard typecheck, diff check, GitNexus detect-changes | Test-only bead; runtime host startup and route mounting remain covered by existing route/smoke gates rather than duplicated here |
| `forge-6oae.10` | API parity gate for core-backed feed route | `/api/feed` route-to-core DTO parity assertion, API gate suite, gitboard typecheck, diff check, GitNexus detect-changes | Test-only bead; future substrate, specialists, graph, sources, GitHub, and internal logs parity assertions should be added as those routes become core-backed |
| `forge-6oae.6` | `source-lifecycle` contracts and source-health vocabulary | GitNexus impact for `makeSourceHealth` reported CRITICAL; core source-health/source-lifecycle tests, app source-health/sources tests, typecheck/build, staging smoke, diff check, GitNexus detect-changes | App source-health helper and scanner/watcher implementations remain app-owned; moving `makeSourceHealth` itself requires a dedicated parity slice because it impacts graph, specialists, GitHub poller, and `createApp` |
| `forge-6oae.13` | `source-health` compatibility wrapper | GitNexus CRITICAL impact acknowledged for `makeSourceHealth`; app helper-to-core parity test, source/API route tests, GitHub poller source-health tests, typecheck/build, staging smoke, diff check, GitNexus detect-changes | Scanner/watcher implementations and source route services remain app-owned; future slices can migrate consumers one cluster at a time |
| `forge-6oae.7` | GitHub durable store | GitNexus impact for `GithubPoller` reported MEDIUM and store functions LOW; core export tests, app store wrapper tests, GitHub poller/route tests, package build/typecheck, local staging smoke, diff check, GitNexus detect-changes | Poller/discovery/readme stay app-owned because they carry websocket/source-health/logging/token behavior; next slice should extract those behind explicit core runtime hooks |
| `forge-6oae.8` | GitHub legacy adapter DB factory compatibility shell | GitNexus impact for `createDatabase` reported MEDIUM; core GitHub store tests, app DB wrapper parity tests, GitHub store/poller/route tests, typecheck/build, local staging smoke, diff check, GitNexus detect-changes | `apps/gitboard` still owns poller/discovery/readme, HTTP route DTO assembly, terminal safety gates, and scanner watchers; shell thinning continues one owner surface at a time |
| `forge-6oae.11` | Repeatable staging smoke/log gate | `bun run --cwd apps/gitboard smoke:deprecation`, app typecheck, diff check, GitNexus detect-changes | Smoke remains local/staging only and intentionally sets `SKIP_GITHUB_POLLER=1`; production `gitboard.service` restart is still manual |

## Non-Negotiables

- Console remains UI/read/query only. It must not open SQLite or own runtime
  writes.
- Current API routes stay mounted during migration.
- Feed cursor ordering, forensic/evidence envelopes, source-health degraded
  semantics, websocket hints, and request/error/slow logs must remain stable.
- GitHub adapter state is durable runtime state, not temporary bridge cleanup.
- Production `gitboard.service` restart remains manual.
