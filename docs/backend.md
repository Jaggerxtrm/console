# Gitboard Backend Architecture

This document is the canonical backend reference for Gitboard. It describes the native Bun service, request routing, data stores, Beads/Dolt integration, realtime channels, graph generation, specialist observability, terminal bridge, operational logging, caching, degradation behavior, and production diagnostics.

Gitboard currently lives primarily in `apps/gitboard`, but it intentionally reuses the Beadboard control-plane code from `apps/beadboard` for Beads API routes and filesystem/Dolt change watching.

<!-- INDEX:START -->
## Index
- [Runtime Overview](#runtime-overview)
- [Process Startup](#process-startup)
- [Directory and Module Map](#directory-and-module-map)
- [Configuration and Environment](#configuration-and-environment)
- [HTTP Server Lifecycle](#http-server-lifecycle)
- [Hono App Composition](#hono-app-composition)
- [Static Asset Serving](#static-asset-serving)
- [Request Logging and Realtime Log Fanout](#request-logging-and-realtime-log-fanout)
- [SQLite Application Store](#sqlite-application-store)
- [GitHub Data Pipeline](#github-data-pipeline)
- [Beads Project Discovery](#beads-project-discovery)
- [Beads API](#beads-api)
- [Dolt Integration and Degradation](#dolt-integration-and-degradation)
- [JSONL Fallback](#jsonl-fallback)
- [Beads Change Watcher](#beads-change-watcher)
- [WebSocket Channels](#websocket-channels)
- [Specialist Observability](#specialist-observability)
- [Graph Backend](#graph-backend)
- [Terminal and Shell Backend](#terminal-and-shell-backend)
- [Internal Diagnostics APIs](#internal-diagnostics-apis)
- [Caching Model](#caching-model)
- [Failure Modes and Recovery Behavior](#failure-modes-and-recovery-behavior)
- [Production Operations](#production-operations)
- [Testing and Verification](#testing-and-verification)
- [Known Sharp Edges](#known-sharp-edges)
<!-- INDEX:END -->

## Runtime Overview

Gitboard is a single native Bun service that combines:

1. A Hono HTTP API.
2. Bun static file serving for the dashboard bundle.
3. A WebSocket hub for dashboard realtime events.
4. A terminal WebSocket bridge for interactive shell sessions.
5. GitHub event/PR/issue/release persistence in `gitboard.sqlite`.
6. Beads issue/project APIs sourced from Dolt, SQLite, or JSONL.
7. Specialist observability APIs sourced from per-repo `observability.db` files.
8. A graph API that builds a Beads dependency graph plus live specialist overlays.
9. Background watchers for Beads changes and specialist observability database mtime changes.

Production target used during current debugging:

```text
Service: systemd --user gitboard.service
URL:     http://100.113.49.52:3030/gitboard
Console: http://100.113.49.52:3030/gitboard/console
Runtime: native Bun, not Docker Compose
```

## Process Startup

Entry point: `apps/gitboard/src/index.ts`.

Startup sequence:

```ts
const DATA_DIR = process.env.GITBOARD_DATA_DIR ?? join(process.cwd(), "data");
const PORT = Number(process.env.PORT ?? 3030);
const HOSTNAME = process.env.HOSTNAME ?? "0.0.0.0";

await mkdir(DATA_DIR, { recursive: true });
const dbPath = join(DATA_DIR, "gitboard.sqlite");
const db = new Database(dbPath);
migrate(db);

const { app, wsHandler } = createApp(db);
```

Then Bun starts the server:

```ts
const server = serve({
  port: PORT,
  hostname: HOSTNAME,
  async fetch(req, server) {
    // static /gitboard + /beadboard
    // /ws dashboard websocket
    // /api/console/terminal/ws/:provider terminal websocket
    // else Hono app.fetch(req)
  },
  websocket: wsHandler.handlers(),
});
```

Important detail: static asset routing is handled before Hono in `index.ts`, while `api/server.ts` also contains static fallback routes for tests/compatibility. Production native Bun requests normally hit the `index.ts` static resolver first.

## Directory and Module Map

```text
apps/gitboard/src/index.ts                       Native Bun entrypoint
apps/gitboard/src/api/server.ts                  Hono app composition + middleware
apps/gitboard/src/api/routes/*.ts                HTTP API route modules
apps/gitboard/src/api/ws/channels.ts             In-memory channel registry + replay buffer
apps/gitboard/src/api/ws/handler.ts              Dashboard + terminal WebSocket handler
apps/gitboard/src/api/terminal/*.ts              Terminal provider registry + bridge
apps/gitboard/src/core/store.ts                  gitboard.sqlite schema migrations
apps/gitboard/src/core/github-store.ts           GitHub event/PR/issue/release DAO
apps/gitboard/src/core/github-poller.ts          GitHub polling + realtime publication
apps/gitboard/src/core/project-scanner.ts        Gitboard-side Beads project scanner
apps/gitboard/src/core/dolt-client.ts            Gitboard-side Dolt SQL client
apps/gitboard/src/core/jsonl-reader.ts           Graph/API JSONL fallback reader
apps/gitboard/src/core/graph-dao.ts              Graph cache + graph builder
apps/gitboard/src/core/logger.ts                 JSONL logs + WS log fanout
apps/gitboard/src/core/shell-provider-policy.ts  Shell/terminal access policy
apps/gitboard/src/server/observability/*.ts      Specialist observability registry/DAO/watcher
apps/beadboard/src/api/routes/beads.ts           Beads API mounted by Gitboard
apps/beadboard/src/core/beads-change-watcher.ts  Beads filesystem/Dolt watcher
apps/beadboard/src/core/project-scanner.ts       Beadboard scanner used by Beads API
apps/beadboard/src/core/dolt-client.ts           Beadboard Dolt client used by Beads API/watcher
```

## Configuration and Environment

Core runtime variables:

| Variable | Used by | Default | Meaning |
|---|---|---:|---|
| `GITBOARD_DATA_DIR` | `index.ts` | `./data` | Directory for `gitboard.sqlite` |
| `PORT` | `index.ts` | `3030` | HTTP port |
| `HOSTNAME` | `index.ts` | `0.0.0.0` | Bind host |
| `GITBOARD_LOG_DIR` | `core/logger.ts` | `./logs` | JSONL app log directory |
| `LOG_DIR` | `api/routes/internal-logs.ts` | `/data/logs` | Internal log-file listing directory |
| `XDG_PROJECTS_DIR` | scanners/Dolt host logic | scanner-specific | Root for project discovery; also changes Dolt host fallback in graph DAO |
| `HOME` | graph scanner | `$HOME/projects` | Fallback search root for graph scanner |
| `GITHUB_TOKEN` | GitHub poller/discovery/readme | none | Enables authenticated GitHub API calls |
| `GITHUB_OWNER` | GitHub discovery | `Jaggerxtrm` | Owner for discovered repos |
| `GITBOARD_ALLOW_LOCAL_SHELL` | shell policy | `false` | Enables local terminal provider |
| `GITBOARD_SHELL_ADMIN_TOKEN` | shell policy | none | Required token for non-loopback shell access |
| `GITBOARD_SHELL_ALLOWED_ORIGINS` | shell policy | localhost/Tailscale defaults | Comma-separated allowed origins |
| `DOLT_HOST` | graph DAO | `127.0.0.1` or `host.docker.internal` | Host used by graph Dolt client |

Shell origin defaults allow localhost and the current production Tailscale origin:

```ts
const DEFAULT_ALLOWED_ORIGINS = new Set([
  "http://localhost:3030",
  "http://127.0.0.1:3030",
  "http://100.113.49.52:3030",
]);
```

## HTTP Server Lifecycle

There are two layered request handlers:

1. `apps/gitboard/src/index.ts`: Bun-level static and WebSocket routing.
2. `apps/gitboard/src/api/server.ts`: Hono app, middleware, API route mounting.

Native Bun `fetch` routing:

```ts
if (staticRoot) {
  const pathname = url.pathname.replace(staticRoot.mount, "") || "/";
  const filePath = join(staticRoot.dir, pathname === "/" ? "index.html" : pathname);
  if (existsSync(filePath)) return new Response(Bun.file(filePath));
  return new Response(Bun.file(join(staticRoot.dir, "index.html")));
}

if (url.pathname === "/ws") {
  if (server.upgrade(req, { data: { path: url.pathname } })) return;
  return new Response("WebSocket upgrade failed", { status: 400 });
}

if (url.pathname.startsWith("/api/console/terminal/ws/")) {
  if (wsHandler.upgradeTerminal(req, server)) return;
  return new Response("Terminal WebSocket upgrade failed", { status: 400 });
}

return app.fetch(req);
```

## Hono App Composition

`createApp(db)` wires all backend subsystems.

Key construction steps:

```ts
const app = new Hono();
const registry = new ChannelRegistry();
const wsHandler = new WsHandler(registry);
setRealtimePublisher(registry);

currentWatcher = new BeadsChangeWatcher({ registry });
currentWatcher.start();

currentObservabilityWatcher = createObservabilityWatcher(listRepos());
currentObservabilityWatcher.start();
```

Mounted routes:

```ts
app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/api/github", createGithubRouter(db, registry));
app.route("/api/beads", beadsRoutes);
app.route("/api/specialists", createSpecialistsRouter());
app.route("/api/console/observability", createObservabilityRouter());
app.route("/api/console/graph", createGraphRouter());
app.route("/api/console/shell", createShellRouter());
app.route("/api/console/terminal", createTerminalRouter());
app.route("/api/internal", createInternalDoltHealthRouter());
app.route("/api/internal", createInternalLogsRouter());
```

### Middleware

All routes get CORS:

```ts
app.use("*", cors());
```

All API routes are timed. GitHub, console, and beads routes are logged as `request.timing`; any route above 500 ms is logged as `request.slow`; HTTP errors are logged as `request.error`.

```ts
const ms = Math.round(performance.now() - start);
if (c.req.path.startsWith("/api/github") ||
    c.req.path.startsWith("/api/console") ||
    c.req.path.startsWith("/api/beads")) {
  emit(makeLogEntry("api", "request.timing", "info", undefined, {
    path: c.req.path,
    ms,
    status: c.res.status,
  }));
}
if (ms > 500) emit(makeLogEntry("api", "request.slow", "warn", "slow request", { path: c.req.path, ms }));
```

## Static Asset Serving

Production static roots:

```ts
function resolveStaticRoot(pathname: string): { mount: string; dir: string } | null {
  if (pathname === "/gitboard" || pathname.startsWith("/gitboard/")) {
    return { mount: "/gitboard", dir: join(process.cwd(), "dist/dashboard") };
  }
  if (pathname === "/beadboard" || pathname.startsWith("/beadboard/")) {
    return { mount: "/beadboard", dir: join(process.cwd(), "dist/dashboard") };
  }
  return null;
}
```

`/beadboard` is backward-compatible and serves the same dashboard bundle. The older Beadboard frontend has been deprecated.

## Request Logging and Realtime Log Fanout

Logger: `apps/gitboard/src/core/logger.ts`.

Log entries are JSONL:

```ts
export function makeLogEntry(
  component: LogEntry["component"],
  event: string,
  level: LogEntry["level"],
  msg?: string,
  data?: LogEntry["data"],
): LogEntry {
  return { ts: new Date().toISOString(), level, component, event, ...(msg ? { msg } : {}), ...(data ? { data } : {}) };
}
```

`emit(entry)` writes the entry and publishes it on `system:logs`:

```ts
export function emit(entry: LogEntry): void {
  write(entry);
  realtimePublisher?.publish("system:logs", "log.entry", entry);
}
```

The active log path is date based:

```ts
const defaultLogDir = process.env.GITBOARD_LOG_DIR || join(process.cwd(), "logs");
return join(defaultLogDir, `${date}.jsonl`);
```

Common event families:

```text
api request.timing/request.slow/request.error
api graph.*
api specialists.*
dolt beads.source.timing / source.degraded / graph.source.timing
watcher poll.* / beads.issue.detected / batch.published
ui beads.feed.* / specialists.in_flight.*
terminal-bridge terminal.*
```

Client telemetry is accepted by `POST /api/internal/logs/client` and re-emitted as component `ui`; same-origin requests are allowed, cross-origin requests are rejected.

## SQLite Application Store

The application SQLite DB is `gitboard.sqlite` under `GITBOARD_DATA_DIR`.

Migration entry: `apps/gitboard/src/core/store.ts`.

Tables created:

```sql
CREATE TABLE github_events (...);
CREATE TABLE github_prs (...);
CREATE TABLE github_issues (...);
CREATE TABLE github_releases (...);
CREATE TABLE github_event_etags (...);
```

Indexes:

```sql
CREATE INDEX idx_github_events_repo_created ON github_events(repo, created_at DESC);
CREATE INDEX idx_github_events_type ON github_events(type);
CREATE INDEX idx_github_prs_repo_updated ON github_prs(repo, updated_at DESC);
CREATE INDEX idx_github_issues_repo_updated ON github_issues(repo, updated_at DESC);
CREATE INDEX idx_github_releases_repo_published ON github_releases(repo, published_at DESC);
CREATE INDEX idx_github_event_etags_repo_endpoint ON github_event_etags(repo, endpoint);
```

Schema is idempotent; `migrate(db)` runs on every startup.

## GitHub Data Pipeline

Route module: `apps/gitboard/src/api/routes/github.ts`.

Store module: `apps/gitboard/src/core/github-store.ts`.

Poller: `apps/gitboard/src/core/github-poller.ts`.

Discovery/readme helpers:

```text
apps/gitboard/src/core/github-discover.ts
apps/gitboard/src/core/github-readme.ts
```

### GitHub API endpoints

Mounted under `/api/github`:

```text
GET /api/github/repos
GET /api/github/repos/stats
GET /api/github/repos/:owner/:repo/events
GET /api/github/repos/:owner/:repo/events/:id
GET /api/github/repos/:owner/:repo/pulls
GET /api/github/repos/:owner/:repo/pulls/:number
GET /api/github/repos/:owner/:repo/issues
GET /api/github/repos/:owner/:repo/releases
GET /api/github/repos/:owner/:repo/readme
POST /api/github/poll/start
POST /api/github/poll/stop
```

### GitHub route behavior

`createGithubRouter(db, registry)` uses `GitHubStore` and can publish realtime events to the registry. It logs timing for repo list serialization:

```ts
const { rows, dbMs } = store.listReposWithStats();
const serializeStart = performance.now();
const body = rows.map(...);
emit(makeLogEntry("api", "github.repos.timing", "info", undefined, {
  dbMs,
  serializeMs,
  rows: body.length,
}));
```

### GitHub persistence

`GitHubStore` owns CRUD/upsert methods for events, PRs, issues, releases, and ETags. Example PR upsert shape:

```ts
INSERT INTO github_prs (...)
VALUES (...)
ON CONFLICT(repo, number) DO UPDATE SET
  title = excluded.title,
  state = excluded.state,
  ...
```

### GitHub poller

`GitHubPoller` fetches GitHub events/PRs/issues/releases with ETag support. It stores ETags in `github_event_etags`, emits API timing logs, and publishes dashboard events when new data arrives.

Rate limiting and conditional fetches:

```ts
const previousEtag = this.store.getEtag(repo, endpoint);
const response = await fetch(url, { headers: { Authorization, Accept, ...(previousEtag ? { "If-None-Match": previousEtag } : {}) } });
if (response.status === 304) emit(makeLogEntry("poller", "etag.hit_304", "debug", undefined, { repo, endpoint }));
```

Realtime GitHub publication uses the channel registry. Published events are consumed by dashboard hooks.

## Beads Project Discovery

There are two project scanners:

1. `apps/beadboard/src/core/project-scanner.ts` powers the Beads API and `BeadsChangeWatcher`.
2. `apps/gitboard/src/core/project-scanner.ts` powers the graph DAO and some Gitboard-specific code.

Both discover `.beads` directories under a search root and return `BeadsProject` objects.

Important fields:

```ts
type BeadsProject = {
  id: string;
  name: string;
  path: string;
  beadsPath: string;
  doltPort?: number;
  doltDatabase?: string;
  source?: "dolt" | "sqlite" | "jsonl" | "unknown";
  sourceHealth: ...;
  sourcePriority: ...;
};
```

Scanner duties:

- Walk candidate project directories.
- Detect `.beads` metadata.
- Read `.beads/config.yaml`, `.beads/metadata.json`, and Dolt port/runtime files.
- Assign stable project IDs/names.
- Determine source priority and source health.
- Exclude heavyweight directories like `node_modules`, `.git`, caches, user system dirs.

## Beads API

Gitboard mounts Beadboard's API directly:

```ts
import { beadsRoutes } from "../../../beadboard/src/api/routes/beads.ts";
app.route("/api/beads", beadsRoutes);
```

Primary endpoints:

```text
GET /api/beads/projects
GET /api/beads/projects/:projectId/connection
GET /api/beads/projects/:projectId/issues
GET /api/beads/projects/:projectId/issues/closed
GET /api/beads/projects/:projectId/issues/:issueId
GET /api/beads/projects/:projectId/memories
GET /api/beads/projects/:projectId/interactions
GET /api/beads/projects/:projectId/stats
```

### Issue list flow

```ts
beadsRoutes.get("/projects/:projectId/issues", async (c) => {
  const projectId = c.req.param("projectId");
  const status = c.req.query("status")?.split(",") as BeadIssue["status"][] | undefined;
  const priority = c.req.query("priority")?.split(",").map(Number) as BeadIssue["priority"][] | undefined;
  const search = c.req.query("search");
  const limit = Number(c.req.query("limit")) || 100;

  const issues = await getIssuesFromProject(projectId, { status, priority, search, limit });
  return c.json({ issues });
});
```

Current telemetry enriches this with `beads.issues.response`, including project ID, filters, row count, newest issue, and the first issue IDs.

### Source order

Beads route source order depends on project source:

```ts
function sourceOrder(source: BeadsProject["source"]): Array<"dolt" | "sqlite"> {
  if (source === "dolt" || source === "unknown") return ["dolt", "sqlite"];
  if (source === "sqlite") return ["sqlite", "dolt"];
  return ["sqlite"];
}
```

If Dolt and SQLite fail, JSONL is used.

## Dolt Integration and Degradation

There are two Dolt clients:

- `apps/beadboard/src/core/dolt-client.ts` for Beads API and watcher.
- `apps/gitboard/src/core/dolt-client.ts` for graph DAO.

Both query Dolt's SQL server with Bun MySQL client behavior and provide issue/dependency hydration.

### Degraded source health

When Dolt fails, the Beads API produces a structured source-health response and logs a warning:

```ts
emit(makeLogEntry("dolt", "source.degraded", "warn", `${message}; reading JSONL backup. Data may be stale.`, {
  projectId: project.id,
  projectPath: project.path,
  status,
  ...details,
}));
```

Common statuses:

```text
dolt_missing_config
pid_file_missing
dolt_process_dead
dolt_unreachable
dolt_auth_failed
dolt_database_missing
unknown
```

### Circuit breaker behavior

Dolt clients track consecutive failures. After enough failures, a breaker opens and requests fall back to JSONL until the breaker window expires. This prevents a dead Dolt SQL server from blocking every dashboard refresh.

Example logs observed in production:

```json
{"component":"breaker","event":"breaker.opened","data":{"consecutiveFailures":18,"poolKey":"127.0.0.1:13839/dolt/root"}}
{"component":"dolt","event":"source.degraded","data":{"projectId":"4c37df93-...","status":"dolt_unreachable","error":"Dolt circuit breaker open"}}
```

## JSONL Fallback

Fallback reader: `apps/gitboard/src/core/jsonl-reader.ts`.

For graph/API fallback, live JSONL is now preferred:

```ts
export async function readIssuesFromJsonl(beadsPath: string): Promise<BeadIssue[]> {
  const live = await readLiveIssuesFromJsonl(beadsPath);
  if (live.length > 0) return live;
  return readBackupIssuesFromJsonl(beadsPath);
}
```

This is important because the current Beads source of truth is usually:

```text
.beads/issues.jsonl
.beads/interactions.jsonl
.beads/metadata.json
.beads/config.yaml
```

Older imports used:

```text
.beads/backup/issues.jsonl
.beads/backup/dependencies.jsonl
.beads/backup/labels.jsonl
```

Live issue parser supports `_type: "issue"`, `assignee`, `parent_id`, inline dependencies, labels, and `related_ids`.

## Beads Change Watcher

Class: `apps/beadboard/src/core/beads-change-watcher.ts`.

Started by `createApp`:

```ts
currentWatcher = new BeadsChangeWatcher({ registry });
currentWatcher.start();
```

It scans all Beads projects, installs filesystem watchers on `.beads/issues.jsonl`, polls Dolt commit hashes, reads snapshots, computes diffs, and publishes events through the WebSocket channel registry.

Timing constants:

```ts
const ACTIVE_POLL_MS = 30_000;
const IDLE_POLL_MS = 60_000;
const WATCH_DEBOUNCE_MS = 1_000;
const COALESCE_MS = 1_500;
const MAX_BATCH = 50;
```

Fast path skips expensive snapshot reads when Dolt commit hash is unchanged and a previous snapshot exists:

```ts
if (commitHash && prevHash === commitHash && haveSnapshot) {
  emit(makeLogEntry("watcher", "poll.skipped", "debug", undefined, { projectId: project.id }));
  this.enqueue({ event: "beads:source_health", ... });
  return;
}
```

Snapshot read flow:

```ts
emit(makeLogEntry("watcher", "poll.snapshot_read", "info", undefined, { projectId: project.id }));
const snapshot = await this.readSnapshot(project);
const previous = this.previous.get(project.id);
const drift = Boolean(previous && previous.issues.length !== snapshot.issues.length);
```

Diff events:

```text
beads:source_health
beads:issue.upsert
beads:issue.close
beads:issue.delete
beads:issue.flagged
beads:issue.unflagged
beads:issue.superseded
beads:issue.deferred
beads:dep.upsert / beads:dep.delete
beads:memory.upsert / beads:memory.delete
beads:kv.upsert / beads:kv.delete
```

Batch behavior:

- Normal batches publish `beads:batch` per project plus individual events.
- Overflow batches publish `beads:sync_hint` only, forcing clients to refetch.
- Batch telemetry includes project IDs, event counts, and issue event summaries.

Snippet:

```ts
if (overflow || batch.length > MAX_BATCH) {
  registry.publish("beads:changes", "beads:sync_hint", { reason: "overflow" }, batch.at(-1)?.version);
  return;
}

for (const [projectId, events] of grouped) {
  registry.publish("beads:changes", "beads:batch", {
    project_id: projectId,
    issues: events.filter((e) => e.event === "beads:issue.upsert").map((e) => e.data.issue),
    dependencies: ...,
  }, events.at(-1)?.version);
}
```

## WebSocket Channels

Channel registry: `apps/gitboard/src/api/ws/channels.ts`.

Channels:

```ts
export type ChannelName =
  | "github:events"
  | "beads:changes"
  | "system:logs"
  | "terminal:streams"
  | "specialists:activity";
```

Each channel has:

- Subscriber set.
- Sequence number.
- Boot ID.
- Replay buffer of 500 messages.

Publish shape:

```ts
const envelope: WsEnvelope = {
  type: "event",
  channel,
  event,
  data,
  seq: state.seq,
  boot_id: state.bootId,
  ts: new Date().toISOString(),
  version,
};
```

Replay behavior:

- Clients subscribe to channels by sending `subscribe` messages.
- Clients can resume from sequence using `resume`.
- If replay buffer cannot satisfy resume, handler emits a `*:sync_hint` event.

`WsHandler` maps buffer misses to channel-specific sync hints:

```ts
conn.raw.send(JSON.stringify({
  type: "event",
  channel,
  event: channel.startsWith("beads:")
    ? "beads:sync_hint"
    : channel.startsWith("specialists:")
      ? "specialists:sync_hint"
      : "github:sync_hint",
  data: { reason: "buffer_miss", channel, since_seq: sinceSeq },
}));
```

Dashboard log entries are also published on `system:logs` by the logger.

## Specialist Observability

Specialist observability reads external `observability.db` SQLite databases for each repo.

Key files:

```text
apps/gitboard/src/server/observability/registry.ts
apps/gitboard/src/server/observability/attach-pool.ts
apps/gitboard/src/server/observability/dao.ts
apps/gitboard/src/server/observability/watcher.ts
apps/gitboard/src/server/observability/epoch.ts
apps/gitboard/src/api/routes/specialists.ts
```

### Registry

`registry.ts` discovers repo observability DBs and returns entries like:

```ts
type RepoEntry = {
  repoSlug: string;
  dbPath: string;
  mtimeMs: number;
};
```

### Attach pool

`createAttachPool(repos)` attaches multiple SQLite DBs and queries them as one logical source.

### Observability DAO

Core methods exposed to route layer:

```ts
jobsByBead(beadId: string): SpecialistJob[];
inFlightJobs(): SpecialistJob[];
recentJobs(limit: number): SpecialistJob[];
chainById(chainId: string): SpecialistChain[];
summary(): ObservabilitySummary;
```

Job shape:

```ts
export type SpecialistJob = {
  jobId: string;
  chainId: string | null;
  beadId: string;
  repoSlug: string;
  status: string;
  specialist: string | null;
  chainKind: string | null;
  phase: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  lastEventAt: string | null;
  eventCount: number;
};
```

### Specialist routes

Mounted under `/api/specialists`:

```text
GET /api/specialists/jobs?bead_id=<id>
GET /api/specialists/jobs/in-flight?limit=<n>
GET /api/specialists/chains/:chain_id
```

In-flight route returns both `in_flight` and `jobs` for frontend compatibility:

```json
{
  "in_flight": [ ... ],
  "recent_history": [ ... ],
  "jobs": [ ... ],
  "epoch": { "gitboard": 13 },
  "freshness": "fresh",
  "source_health": { "status": "fresh" }
}
```

### Specialist route cache

`createSpecialistsRouter` caches:

```ts
let jobsByBeadCache: CachedValue<{ jobs: SpecialistJob[] }> | null = null;
let inFlightCache: CachedValue<{ in_flight: SpecialistJob[]; recent_history: SpecialistJob[]; jobs: SpecialistJob[]; epoch: Record<string, number> }> | null = null;
let chainCache: CachedValue<{ chain: { jobs: SpecialistChain[] } }> | null = null;
```

Cache keys include repo slug and repo epoch:

```ts
function cacheKey(route: string, repos: SpecialistRepoSummary, epochGetter: (repoSlug: string) => number, discriminator: string): string {
  return [route, ...repos.map((repo) => `${repo.repoSlug}:${epochGetter(repo.repoSlug)}`), discriminator].join("|");
}
```

Cold refreshes use a route warm timeout:

```ts
const ROUTE_WARM_TIMEOUT_MS = 750;
const refreshed = await withTimeout(refreshInFlight(...), ROUTE_WARM_TIMEOUT_MS);
```

If refresh exceeds timeout, route returns stale source health. The dashboard now preserves prior jobs when a stale empty response arrives to avoid chip flicker.

### Observability watcher

`createObservabilityWatcher(entries)` watches parent directories and DB files for mtime changes. On change it calls `bump(repoSlug)`, which increments an in-memory epoch and notifies subscribers.

The bridge in `createApp` publishes epoch bumps to WebSocket clients:

```ts
onObservabilityBump((repoSlug, epoch) => {
  registry.publish(
    "specialists:activity",
    "specialists:sync_hint",
    { reason: "epoch_bump", repo_slug: repoSlug },
    String(epoch),
  );
});
```

## Graph Backend

Route: `apps/gitboard/src/api/routes/graph.ts`.

DAO: `apps/gitboard/src/core/graph-dao.ts`.

Endpoint:

```text
GET /api/console/graph?project_id=<project-id-or-name>&include_closed=true|false&refresh=true|false
POST /api/console/graph/invalidate
```

The route supports both `project` and `project_id` query params:

```ts
const projectId = c.req.query("project") ?? c.req.query("project_id");
const includeClosed = c.req.query("include_closed") === "true";
if (c.req.query("refresh") === "true") dao.invalidate(projectId);
const { graph, freshness } = await dao.getGraphSnapshotWarm(projectId, includeClosed);
return c.json({ ...graph, freshness, source_health: makeGraphSourceHealth(graph, freshness) });
```

### Graph response

```ts
export interface GraphResponse {
  project_id: string;
  repo_slug: string;
  generated_at: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  specialists: GraphSpecialist[];
}
```

Nodes contain Beads issues:

```ts
{
  id: issue.id,
  title: issue.title,
  type: normalizeNodeType(issue.issue_type),
  priority: issue.priority,
  status: normalizeStatus(issue.status),
  assignee: issue.owner,
  closed_at: issue.closed_at ?? null,
  superseded_by: ...,
}
```

Edges come from issue dependencies:

```ts
const allEdges = issues.flatMap((issue) =>
  issue.dependencies.map((dependency) => normalizeEdge(issue.id, dependency)).filter(Boolean)
);
```

Specialist overlays are live jobs with statuses:

```ts
const LIVE_STATUSES = new Set(["starting", "running", "waiting"]);
const specialistsOverlay = specialists.filter((job) => LIVE_STATUSES.has(job.status)).map(toSpecialist);
```

### Graph active statuses

Default graph excludes closed issues but includes:

```ts
const ACTIVE_GRAPH_STATUSES = ["open", "in_progress", "in_review", "blocked", "deferred"] as const;
```

### Graph cache layers

```ts
const PROJECT_REFRESH_MS = 30_000;
const ISSUE_REFRESH_MS = 10_000;
const GRAPH_WARM_TIMEOUT_MS = 750;
const GRAPH_SNAPSHOT_CACHE_MS = 10_000;
```

Caches:

```text
projectScanCache      ProjectScanner -> scanned projects
projectScanInflight   ProjectScanner -> scan promise
issueCache            project+epoch+includeClosed -> issues
issueInflight         same key -> refresh promise
graphSnapshotCache    project+includeClosed+issueKey -> final graph payload
projectIssueEpochs    per-project invalidation counter
globalIssueEpoch      global invalidation counter
```

### Warm snapshot behavior

`getGraphSnapshotWarm()` tries to avoid blank states by warming project scan and issue cache within `GRAPH_WARM_TIMEOUT_MS` before returning a snapshot.

If a cached issue entry exists but is expired and empty, the backend no longer short-circuits to that stale empty graph; it attempts warm loading instead.

### Source health

Graph source health is attached to every response:

```ts
return c.json({ ...graph, freshness, source_health: makeGraphSourceHealth(graph, freshness) });
```

If missing or unknown project:

```json
{
  "freshness": "degraded",
  "source_health": {
    "source": "graph",
    "status": "degraded",
    "message": "Graph project_id is missing; select a beads project."
  }
}
```

### Graph fallback bug fixed

A production issue occurred where Dolt circuit breaker opened and graph fell back to JSONL, but the reader used `.beads/backup/issues.jsonl` and returned zero rows. Current behavior prefers `.beads/issues.jsonl`, restoring graph data during Dolt fallback.

## Terminal and Shell Backend

Routes:

```text
GET /api/console/shell/status
GET /api/console/terminal/providers
WebSocket /api/console/terminal/ws/:provider
```

### Shell status

`createShellRouter()` returns policy status:

```ts
router.get("/status", (c) => c.json(getShellProviderStatus(c.req.raw)));
```

Status includes whether shell provider is enabled, whether auth is required, allowed origins, and rejection reason.

### Shell policy

Core rules from `shell-provider-policy.ts`:

- Local shell disabled unless `GITBOARD_ALLOW_LOCAL_SHELL=true` or `1`.
- Loopback requests can be allowed without token.
- Non-loopback requires allowed origin and admin token when configured.
- Tailscale production origin is in default allowed origins.

### Terminal provider registry

`createTerminalProviderRegistry()` registers providers. Current provider:

```ts
registry.set("local", {
  id: "local",
  label: "Local shell",
  createSession(options) {
    return new LocalPtyProvider().createSession(options);
  },
});
```

`GET /api/console/terminal/providers` lists providers and shell policy status.

### Terminal WebSocket bridge

`TerminalBridge` owns session lifecycle:

```text
open       -> create session
input      -> write stdin
data       -> provider emits stdout/stderr
audit      -> provider emits command/metadata audit events
resize     -> resize terminal
close      -> close session
```

Outbound envelope examples:

```json
{ "type": "ready", "sessionId": "...", "provider": "local", "shell": "/bin/bash", "cwd": "/home/dawid/dev/gitboard" }
{ "type": "data", "sessionId": "...", "data": "..." }
{ "type": "exit", "sessionId": "...", "code": 0 }
```

### Local PTY provider

`LocalPtyProvider` spawns a shell through `node-pty` helper. It emits audit events, supports resizing, handles idle timeouts, and cleans up on close.

Security boundaries are policy-based, not container isolation; production should keep shell disabled unless explicitly needed.

## Internal Diagnostics APIs

Mounted under `/api/internal`.

### Logs

```text
GET  /api/internal/logs
GET  /api/internal/logs/files
POST /api/internal/logs/client
```

`GET /logs` and `/logs/files` require localhost host header. Client log ingestion enforces same origin when `Origin` is present.

### Dolt health

```text
GET /api/internal/dolt/health
```

Returns Beads projects with Dolt config and source-health metadata:

```ts
const projects = new ProjectScanner(...).scanAll();
return c.json({ projects: projects.map((project) => ({ id, name, path, doltPort, doltDatabase, source, sourceHealth })) });
```

## Caching Model

| Subsystem | Cache | Key | TTL/Invalidation |
|---|---|---|---|
| Graph projects | `projectScanCache` | scanner instance | 30s |
| Graph issues | `issueCache` | project id + global epoch + project epoch + includeClosed | 10s |
| Graph final payload | `graphSnapshotCache` | project id + includeClosed + issue key | 10s |
| Specialists jobs by bead | local route cache | route + repo epochs + bead id | epoch-based |
| Specialists in-flight | local route cache | route + repo epochs + limit | epoch-based |
| Specialists chains | local route cache | route + repo epochs + chain id | epoch-based |
| Observability DAO | `defaultBundle` | repo list + mtimes | 30s warm window |
| GitHub HTTP | ETags | repo + endpoint | GitHub-driven 304 |
| WebSocket replay | channel replay buffer | channel | last 500 events |

## Failure Modes and Recovery Behavior

### Dolt down

Expected behavior:

1. Dolt client throws or breaker opens.
2. API logs `source.degraded`.
3. API reads JSONL fallback.
4. UI receives source health instead of misleading blank state.
5. Once Dolt recovers, subsequent requests return Dolt rows again.

### Graph stale/empty cache

Expected behavior after current fixes:

- Expired non-empty cache returns stale graph while background refresh happens.
- Expired empty cache does not short-circuit warm loading.
- JSONL fallback uses live `.beads/issues.jsonl` first.

### Specialist stale timeout

Expected behavior:

- `/api/specialists/jobs/in-flight` may return `freshness: "stale"` and empty jobs if refresh exceeds 750 ms.
- Dashboard preserves previous jobs when stale-empty arrives.
- This prevents active specialist chips from disappearing between refreshes.

### WebSocket replay gap

Expected behavior:

- Registry detects replay gap.
- Handler sends `beads:sync_hint`, `specialists:sync_hint`, or `github:sync_hint`.
- Client refetches/coalesces instead of trusting partial replay.

### Large Beads batch

Expected behavior:

- If batch exceeds `MAX_BATCH=50`, watcher publishes `beads:sync_hint` instead of all events.
- Client refetches relevant Beads data.

## Production Operations

### Build and restart

```bash
cd apps/gitboard
bun run build:dashboard
systemctl --user restart gitboard
systemctl --user --no-pager --lines=50 status gitboard
```

### Smoke checks

```bash
curl -i http://100.113.49.52:3030/health
curl -i http://100.113.49.52:3030/gitboard
curl -i http://100.113.49.52:3030/gitboard/console
```

### Beads project check

```bash
curl -s http://100.113.49.52:3030/api/beads/projects | jq '.projects[] | select(.name=="gitboard")'
```

### Graph check

```bash
curl -s 'http://100.113.49.52:3030/api/console/graph?project_id=gitboard&refresh=true' \
  | jq '{project_id, repo_slug, nodes: (.nodes|length), edges: (.edges|length), freshness, source_health}'
```

Healthy Gitboard graph should return non-zero nodes and `source_health.status == "fresh"`.

### Specialist check

```bash
curl -s 'http://100.113.49.52:3030/api/specialists/jobs/in-flight?limit=100' \
  | jq '{freshness, jobs: (.jobs|length), beadIds: [.jobs[].beadId] | unique}'
```

### Logs

Default production logs in current session were under:

```text
/home/dawid/.agent-forge/logs/YYYY-MM-DD.jsonl
apps/gitboard/logs/YYYY-MM-DD.jsonl
logs/YYYY-MM-DD.jsonl
```

Useful grep patterns:

```bash
grep -E 'graph\.|source.degraded|beads\.source|specialists\.in_flight|beads.feed.render_state' /home/dawid/.agent-forge/logs/$(date -u +%F).jsonl | tail -200
```

### Specialist dispatch smoke

```bash
export PATH="$HOME/.bun/bin:$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
sp run explorer --bead forge-qz27 --context-depth 2 --timeout 180 --max-turns 2 --max-tool-calls 8 --json --no-stream \
  "Scope: telemetry smoke test. Authority: READ_ONLY. Commands allowed: inspect logs/status only. Expected output: concise summary."
```

Then verify:

```bash
sp ps
curl -s 'http://100.113.49.52:3030/api/specialists/jobs/in-flight?limit=100' | jq '.jobs[] | select(.beadId=="forge-qz27")'
```

## Testing and Verification

Common targeted tests:

```bash
cd apps/gitboard
bun test tests/api/routes/graph.test.ts tests/core/graph-dao.cache.test.ts
bun test tests/api/specialists.cache.test.ts
bun test tests/dashboard/components/beads/IssueFeed.identity.test.ts
bun run build:dashboard
```

Beadboard watcher test:

```bash
cd apps/beadboard
bun test tests/core/beads-change-watcher.test.ts
```

Known full typecheck caveat in current tree:

```text
bun run typecheck
```

Currently has unrelated/pre-existing failures around:

- `MainPane.tsx` surface indexing.
- `graph-dao.cache.test.ts` fixture missing `source_health` in some branch states.
- `useWebSocket.test.tsx` jest-dom matcher typings.

## Known Sharp Edges

1. **Two project scanners exist.** Beads API and graph DAO use separate scanner implementations. Keep source-health and identity matching behavior aligned.
2. **Dolt can degrade per project.** Dolt ports may be dead, missing, or circuit-broken. JSONL fallback must always be correct.
3. **Graph must never treat stale empty as authoritative.** Stale empty graph data caused misleading “No beads” states during tab switches.
4. **Specialist stale-empty responses must not clear chips.** Preserve prior jobs when route freshness is stale and the response has no jobs.
5. **Terminal bridge is powerful.** Keep shell disabled unless intentionally enabled and protected by origin/token checks.
6. **`/beadboard` is compatibility only.** It serves the Gitboard dashboard bundle.
7. **Client telemetry is operationally useful.** `beads.feed.render_state`, `beads.feed.load_result`, and `specialists.in_flight.received` are key for diagnosing blank/refresh behavior.
8. **Graph specialist overlays can appear even when graph nodes are empty.** That indicates observability works but issue source/cache failed.
9. **API route warm timeouts are intentional.** They protect UI latency but require stale-preservation semantics on the frontend.
10. **Production process PATH matters for specialists.** `sp` uses `#!/usr/bin/env bun`; process managers must include `$HOME/.bun/bin`.

