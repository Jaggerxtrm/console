# Console Host Retirement Spec

**Status:** completed historical plan; use `docs/deployment.md` for current operations
**Created:** 2026-07-05
**Scope:** finish the real migration off the deprecated `apps/gitboard` production host.

## Problem

The previous migration moved runtime logic into `packages/core`, but production still starts `apps/gitboard/src/index.ts` through `gitboard.service`. That allowed migration work to close as PASS while retaining the deprecated host and proving only that the old host still worked.

This spec defines the final migration gate: the live Console service must run from a replacement Console host, not from `apps/gitboard`.

## Acceptance Gate (PASS / PARTIAL / FAIL)

| Verdict | Meaning |
|---------|---------|
| **PASS** | Production service runs entirely from the Console host. `ExecStart` is outside `apps/gitboard`. No production code imports `apps/gitboard` modules. Guard (`tools/retirement/host-retirement-guard.ts --mode strict`) exits 0. |
| **PARTIAL** | Console host exists and serves some traffic, but deprecated host references remain in production paths (ExecStart, Dockerfile CMD, build scripts). `Removed wrappers: none` is always PARTIAL, never PASS. Guard exits 1 in strict mode but no-new-regressions mode passes. |
| **FAIL** | No Console host exists, or new production references to `apps/gitboard` are introduced beyond the committed baseline. Guard exits 1 in no-new-regressions mode. |

**Retained wrappers are PARTIAL for host retirement.** Any phase that closes while `apps/gitboard` still appears in ExecStart, Dockerfile CMD, or production build scripts must record PARTIAL, not PASS.

**Bridge-table and read-model retirement is explicitly out of scope** for this migration. Bridge SQLite tables, daemon-served read-model contracts, and materializer parity harnesses may remain after the host cutover without affecting the PASS/PARTIAL/FAIL verdict.

## Success Criteria

The migration is complete only when all are true:

- `systemctl --user cat gitboard.service` or its successor shows `ExecStart` outside `apps/gitboard`.
- Production code for the live service does not import `apps/gitboard` modules.
- `/console`, `/health`, required `/api/*`, realtime WebSocket, internal logs, source/materializer lifecycle, and terminal status/no-leak behavior are served by the replacement host.
- `/gitboard` no longer serves `apps/gitboard` assets. It may redirect to `/console` or show a small deprecation page.
- Tailnet deploy monitor proves the replacement host is fresh, healthy, and not regressing.
- Any remaining `apps/gitboard` references are classified as docs/history/test-fixture only.

`Removed wrappers: none` is **PARTIAL**, never PASS, for this migration.

## Non-goals

- Do not retire bridge SQLite tables in this migration.
- Do not require daemon-served read-model contracts before replacing the production host.
- Do not redesign Console UI, Explore, Observability, or write operations.
- Do not delete durable GitHub adapter state.
- Do not weaken terminal/shell security gates.

## State At Plan Creation

- Production service currently runs `apps/gitboard/src/index.ts`.
- `apps/console` is primarily the Vite frontend app.
- `packages/core` owns much of the runtime logic, but it is a library, not the deployed host.
- `apps/gitboard/src/api/server.ts` still owns host composition, static serving, route mounting, Bun WebSocket upgrade glue, terminal bridge wiring, scanner/materializer startup, and deploy monitor targets.

## Risk Map

GitNexus impact checks from planning:

| Surface | Risk | Notes |
| --- | ---: | --- |
| `ChannelRegistry` / realtime | CRITICAL | WebSocket protocol, log publication, materializer/source hints |
| `UnifiedScanner` / source lifecycle | HIGH | Discovery, source refresh, graph/source health |
| `createApp` | HIGH | Main host composition path |
| `createSpecialistsRouter` | HIGH | Specialists activity/read model and source health |
| `createGraphDao` | HIGH | Console graph joins, health metadata, materializer triggers |
| `TerminalBridge` | Security-sensitive | Graph risk lower, but shell/PTY boundary is sensitive |
| `startServer` | Production-critical | Graph risk lower, but service cutover depends on it |

## Target Architecture

### Replacement host

Add a production Bun/Hono host under `apps/console`, for example:

```text
apps/console/src/server.ts
apps/console/src/server/routes/**
apps/console/src/server/ws/**
apps/console/src/server/terminal/**
```

The host owns deployment/runtime glue:

- bind host/port
- `/health`
- static `/console`
- `/gitboard` redirect/deprecation response
- route mounting
- Bun WebSocket upgrade handling
- terminal WebSocket upgrade handling
- scanner/materializer/watcher startup and shutdown
- production structured logging boundary

`packages/core` continues to own reusable logic, policies, protocols, read-model services, and materializer/runtime primitives.

### Service cutover

Preferred final shape:

```text
ExecStart=/home/dawid/.bun/bin/bun /home/dawid/dev/console/apps/console/src/server.ts
```

Resolved: introduce `console.service` at cutover rather than reusing the `gitboard.service` name. The executable path must not reference `apps/gitboard`.

## Phased Plan

### Phase 0 — Hard gate and docs

Define the acceptance gate before moving code.

Deliverables:

- Document that retained wrappers are PARTIAL for host retirement.
- Add guard test or script that fails if production host paths/scripts use `apps/gitboard`.
- Keep bridge table/read-model retirement explicitly out of scope.

Guard invocation:

```bash
# FAIL against current state (expected until Phase 7 cutover)
bun run tools/retirement/host-retirement-guard.ts --mode strict

# PASS against intended console-host fixture
bun run tools/retirement/host-retirement-guard.ts --mode console-host

# PASS while no new references are introduced beyond baseline
bun run tools/retirement/host-retirement-guard.ts --mode no-new-regressions

# Automated validation (all three modes)
bun test tools/retirement/host-retirement-guard.test.ts
```

Validation:

- Guard fails against the current state and passes against the intended console host fixture.
- Docs name the exact PASS/PARTIAL language.

### Phase 1 — Scaffold Console production host

Create the minimal replacement host in `apps/console`.

Deliverables:

- Bun/Hono server entrypoint.
- `/health` endpoint.
- static `/console` serving from `apps/console/dist`.
- lifecycle hooks for later API/WS/materializer wiring.
- required `apps/console` dependencies (`hono`, and later only what the migrated host actually needs).

Validation:

- `bun run --cwd apps/console lint`
- targeted host tests
- local smoke on a non-production port: `/health`, `/console`
- no production import from `apps/console` to `apps/gitboard`

### Phase 2 — Move read API adapters

Move read/query HTTP adapters needed by the Console host.

Surfaces:

- `/api/substrate`
- `/api/feed`
- `/api/console/graph`
- `/api/sources`
- internal verify/parity routes needed by deploy monitors

Constraints:

- Preserve DTOs and status codes.
- Do not retire bridge tables.
- Keep graph/source-health semantics unchanged.

Validation:

- route parity tests under `apps/console`
- local endpoint smoke
- GitNexus impact attached for `createGraphDao` and moved route symbols

### Phase 3 — Move GitHub, specialists, observability, and Explore adapters

The compatibility-route parity gate is executable in
`apps/console/tests/server/phase2-api-parity.test.ts` and
`apps/console/tests/server/phase3-api-parity.test.ts`. The suites compare the
Gitboard compatibility host and Console owner over isolated, identically
seeded databases. They cover read envelopes, pagination and 404 behavior,
persisted Beads and GitHub writes, specialists freshness/filtering, Explore and
observability read models, bounded internal verification, parity redaction, and
hostile write/internal requests. `bun run --cwd apps/console smoke:api-parity`
then launches both real entrypoints with separate temporary state, home and log
directories and verifies their mounted routes, mutations and bounded verifier
behavior without touching production state. Realtime and terminal protocols
remain in their dedicated Phase 5-6 gates.

Move remaining production API namespaces.

Surfaces:

- `/api/github`
- `/api/specialists`
- `/api/console/observability`
- `/api/console/explore`
- optional `/explore/sql` debug route if still enabled by env

Constraints:

- Preserve GitHub durable adapter state.
- Preserve specialists cache/live/fallback behavior.
- Preserve request timing/error structured logs.
- Do not add write routes or UI redesign work.

Validation:

- moved API tests under `apps/console`
- representative smoke curls for each namespace
- logs still emitted for `/api/github` and `/api/console/*`

### Phase 4 — Move source, scanner, materializer, and watchers

Move live data-loop ownership out of `apps/gitboard`.

Surfaces:

- `UnifiedScanner`
- `ProjectScanner`
- source refresh lifecycle
- beads watcher / trigger watcher
- observability watcher / registry
- materializer registration, source queue, epoch bumps, parity harnesses

Constraints:

- Isolate this phase; do not bundle route cleanup.
- Preserve degraded-readable behavior.
- Preserve structured events: scanner start/stop, refresh start/end, materializer trigger/run/publishHint, watcher start/stop, attach/skip, cleanup.
- Reduce or classify scanner discovery noise; do not add new noisy failure logs.

Validation:

- scanner/source/materializer tests
- local smoke showing `materializer.run` and `materializer.publishHint` from the console host
- source refresh cooldown/in-flight behavior still works

#### Phase 4 verification evidence

`apps/console/tests/smoke/phase4-lifecycle-telemetry.ts` starts the real
Console entrypoint with isolated data, projects, observability, home, and log
directories. It proves discovery and materialization persist an issue and
cursor, checks the live internal-log ring, terminates through SIGTERM, then
checks the flushed JSONL log for all required lifecycle events owned by
`apps/console`. A missing optional JSONL source produces `watcher.skip`
without stopping the runtime. The smoke also starts second Console and legacy
Gitboard processes against the same temporary state database and requires both
writer leases to be rejected while the first host remains healthy. It then
proves lease reacquisition after both graceful SIGTERM and abrupt SIGKILL exits.

```bash
bun run --cwd apps/console smoke:lifecycle
bun run --cwd apps/console smoke:api-parity
bun run --cwd packages/core test
bun run --cwd apps/console test
bun run --cwd apps/gitboard test
bun run build
```

Expected lifecycle-smoke summary: `PASS`, 14 required events, zero
unclassified scanner-discovery warnings for the fixture, Console and Gitboard
contenders rejected, crash lease release confirmed, and `phase4-healthy.1`
persisted. The structured logs are queryable
under `${LOG_DIR}/YYYY-MM-DD.jsonl`; filter by `event` and
`data.owner == "apps/console"`.

### Phase 5 — Move realtime WebSocket and internal logs

Move the highest-risk host boundary.

Surfaces:

- Bun realtime WebSocket upgrade adapter
- `ChannelRegistry` wrapper/use site
- `WsHandler` wrapper/use site
- internal logs route
- logger storage and realtime publisher wiring

Constraints:

- Preserve protocol version and replay behavior.
- Preserve same-origin/token policy.
- Hostile origins must remain denied.
- Do not dump raw WebSocket payloads or secrets into logs.

Validation:

- realtime contract tests
- internal logs tests
- live/local same-origin subscribe smoke
- hostile-origin 403 smoke
- reviewer/security attention because `ChannelRegistry` impact is CRITICAL

Phase 5 verification evidence (2026-07-23): the Console host owns the Bun
upgrade adapter and uses the host-neutral core registry/connection handler
directly. The materializer, GitHub poller, and structured logger publish through
the same registry. Shutdown closes active clients with code `1001`, removes all
subscriptions, and detaches log publication.

```bash
bun run --cwd packages/core test -- tests/runtime-realtime.test.ts
bun run --cwd apps/console test -- tests/server/ws/realtime.test.ts tests/server/ws/host-boundary.test.ts tests/server/github-runtime.test.ts
bun run --cwd apps/console typecheck
bun run --cwd apps/console smoke:realtime
```

Expected realtime-smoke summary: `PASS` with handshake, malformed-input
survival, subscribe/live delivery, reconnect replay, hostile-origin `403`,
internal connect/disconnect telemetry, and no fixture secret or absolute-path
leak in stdout, stderr, or persisted JSONL logs.

### Phase 6 — Move terminal/shell boundary

Move write-capable terminal host glue without weakening security.

Surfaces:

- terminal status route
- terminal WebSocket upgrade adapter
- `TerminalBridge`
- provider registry wiring
- shell provider policy integration
- local PTY provider wiring

Constraints:

- Production default without admin token remains no-leak/disabled.
- Preserve verified-admin gate, origin checks, cwd/shell allowlists, rate limits, TTL/idle cleanup, and readonly specialist-feed behavior.
- Never log shell input/output, tokens, environment secrets, or raw terminal payloads.
- Browser authentication uses a short-lived, one-time, path-scoped `HttpOnly`
  cookie issued by a same-origin POST; credentials never enter a WebSocket URL
  or response body. Direct header authentication remains available to CLI and
  smoke clients.

Validation:

- terminal provider/policy/route tests
- hostile-origin 403 smoke
- no-admin terminal open/write/resize/dispose no-leak proof
- security-auditor/reviewer gate

Phase 6 verification evidence (2026-07-21): Console owns the exact-path Bun
upgrade boundary, `TerminalBridge`, shell/terminal routes, PTY helper, structured
lifecycle telemetry, and shutdown drain. Core keeps the host-neutral provider
and policy implementation; each host injects its own helper path, so core has no
runtime path into either app. The temporary Gitboard provider adapter remains
only to preserve rollback-host parity until Phase 8 deletion.

The browser gate exchanges admin proof for a 30-second one-time `HttpOnly`,
`SameSite=Strict`, WebSocket-path cookie. Origin and loopback-peer checks run
before ticket consumption, replays fail, terminal CORS is origin-restricted,
and client-selected session IDs are excluded from structured telemetry.

```bash
bunx vitest run packages/core/tests/terminal-policy.test.ts packages/core/tests/terminal-provider-registry.test.ts apps/console/tests/server/terminal apps/console/tests/server/ws apps/gitboard/tests/api/terminal/provider-registry.test.ts apps/gitboard/tests/api/routes/terminal.test.ts apps/gitboard/tests/api/routes/shell.test.ts
bun run --cwd packages/core lint
bun run --cwd apps/console typecheck
bun run --cwd apps/gitboard typecheck
bun run --cwd apps/console smoke:terminal
```

Expected terminal-smoke summary: `PASS` with missing/bad-token and hostile
origin `403`, zero PTY children after denied upgrades, malformed-input
survival, positive-token PTY open/resize/input/exit, forbidden cwd, environment
scrub, input rate enforcement, idle cleanup, lifecycle telemetry, and no token,
terminal payload, environment secret, or fixture path in stdout/stderr/JSONL.

### Phase 7 — Production cutover

Switch service execution to the Console host.

Deliverables:

- update service docs/runbook/package scripts
- update unit or successor unit so `ExecStart` is outside `apps/gitboard`
- `/gitboard` redirect/deprecation route, not old asset serving
- deploy monitor artifact under `.xtrm/deploy-monitor/**`

Validation:

- service artifact newer than cutover commit
- `ExecStart` proof outside `apps/gitboard`
- tailnet curls: `/health`, `/console`, representative `/api/*`, shell/terminal status, internal verify
- realtime and terminal no-leak live smokes
- journal review with scanner noise separated from real failures
- 30–60 minute deploy monitor PASS window

### Phase 8 — Quarantine or delete remaining apps/gitboard surfaces

After cutover, remove ambiguity.

Deliverables:

- delete deprecated production host files where safe
- move test fixtures/history if needed
- classify every remaining `apps/gitboard`, `@xtrm/gitboard`, `gitboard.service`, and `/gitboard` reference
- add/keep automated guard against production imports

Validation:

- repo-wide scan shows no production import/start path through `apps/gitboard`
- root build/lint/test pass
- GitNexus detect-changes reports expected cleanup scope

## Test and Review Plan

Required companion validation tracks:

1. **API parity / guard coverage**
   - host guard
   - static `/console`
   - read APIs
   - GitHub/specialists/observability APIs
   - lifecycle smoke
   - no production import from `apps/gitboard`

2. **Security review**
   - realtime origin policy
   - terminal/shell no-leak behavior
   - no sensitive log regressions

3. **Deploy monitor**
   - refuse window if `ExecStart` references `apps/gitboard`
   - prove fresh artifact
   - sample endpoints/logs/materializer/realtime/terminal over scheduled window

4. **Final reviewer gate**
   - classify remaining references
   - GitNexus `detect_changes(compare main)`
   - PASS/PARTIAL/FAIL recommendation

## Bead Decomposition Draft

Later decomposition should create one epic with these implementation children:

1. Define non-negotiable host-retirement gates
2. Scaffold `apps/console` production Bun host
3. Move core Console read API adapters
4. Move GitHub/specialists/observability API adapters
5. Move source scanner/materializer/watcher startup
6. Move realtime websocket/internal log delivery
7. Move terminal/shell boundary
8. Cut production service/static serving to console host
9. Quarantine/delete remaining `apps/gitboard` production surfaces

Companion validation beads:

- Test plan: console host API route parity and guard coverage
- Security review: websocket and terminal cutover
- Deploy monitor: prove replacement console host on tailnet
- Final reviewer gate: classify remaining `apps/gitboard` references

## Resolved Decisions

- Introduce `console.service` at cutover. Do not carry the `gitboard.service` unit name forward; the production unit is `console.service` and its executable path must not reference `apps/gitboard`.
- Permanently redirect `/gitboard` and `/gitboard/*`, plus the old asset paths, to `/console` with HTTP 308 (permanent redirect, method- and body-preserving). No temporary deprecation page.
- Retain the internal verify routes that deployment gates depend on. These routes stay mounted on the Console host so existing health/readiness and deployment verification continue to pass across cutover.

## Open Questions

- Which `apps/gitboard/tests` are pure host tests and should move, versus historical dashboard tests that can be deleted with the old app?
