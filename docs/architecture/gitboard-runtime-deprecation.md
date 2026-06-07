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
| `source-lifecycle` | Pending | `@xtrm/core/runtime` | App supplies env/config only | Core owns discovery and health services; app supplies env/config |
| `github-adapter` | Pending | `@xtrm/core/github` | App wires route/startup only | Core owns durable GitHub adapter state; app wires route/startup |

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

## Non-Negotiables

- Console remains UI/read/query only. It must not open SQLite or own runtime
  writes.
- Current API routes stay mounted during migration.
- Feed cursor ordering, forensic/evidence envelopes, source-health degraded
  semantics, websocket hints, and request/error/slow logs must remain stable.
- GitHub adapter state is durable runtime state, not temporary bridge cleanup.
- Production `gitboard.service` restart remains manual.
