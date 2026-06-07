# Gitboard Runtime Deprecation Map

Status: active migration plan for `forge-6oae`.

`apps/gitboard` is still the live compatibility host. The target state is not to
break its HTTP surface, but to remove runtime ownership from the app: database
schema, materializer lifecycle, read-model SQL, source lifecycle, and durable
GitHub adapter state move to `packages/core`.

The typed source of truth for this map is
`packages/core/src/runtime/ownership.ts`.

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
| `github-adapter` | Durable GitHub store core-owned as of `forge-6oae.7`; poller/discovery/readme still app-owned | `@xtrm/core/github` | `apps/gitboard/src/core/github-store.ts` re-exports the core store; app routes/startup still wire poller, discovery, README enrichment, websocket hints, and source-health updates | Core owns durable GitHub adapter state; app wires route/startup |

## GitHub Adapter Current State

| Layer | Owner | Notes |
|---|---|---|
| Durable store functions and DTOs | `@xtrm/core/github` | Covers events, commits, repos, poll state, PRs, issues, releases, repo stats, contribution summaries, and commit-message enrichment helpers. |
| Compatibility import path | `apps/gitboard/src/core/github-store.ts` | Pure re-export for existing route, poller, and tests. |
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

## Non-Negotiables

- Console remains UI/read/query only. It must not open SQLite or own runtime
  writes.
- Current API routes stay mounted during migration.
- Feed cursor ordering, forensic/evidence envelopes, source-health degraded
  semantics, websocket hints, and request/error/slow logs must remain stable.
- GitHub adapter state is durable runtime state, not temporary bridge cleanup.
- Production `gitboard.service` restart remains manual.
