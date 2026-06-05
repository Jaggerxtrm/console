# Post-Bridge Console Readiness Inventory

Status: `forge-benk.1` inventory, created after the Console telemetry bridge.

This document classifies the repository surfaces before cleanup and before the
next Console migration slice. It is intentionally conservative: it does not
delete or rename anything. Removal candidates are listed as follow-up work so
the running Gitboard service on Tailscale remains stable.

## Current Operating Posture

- Running service: `apps/gitboard`, native Bun process, built dashboard bundle,
  systemd user service, Tailscale-only bind.
- Live deployment contract: `HOST=<tailnet-ip>`, `PORT=3030`,
  `XDG_PROJECTS_DIR=<repo-root-parent>`, `DOLT_HOST=127.0.0.1`,
  `LOG_DIR=~/.xtrm/logs`.
- Runtime entrypoint: `apps/gitboard/src/index.ts`.
- API composition: `apps/gitboard/src/api/server.ts`.
- Current state store: `xtrm.sqlite` in `GITBOARD_DATA_DIR`, with
  `gitboard.sqlite` folded in by `foldGitboardSQLite` when present.
- Current UI shell: Gitboard-hosted Console surface under `/gitboard`, with
  `/api/console/*` APIs and dashboard pages in
  `apps/gitboard/src/dashboard/pages/console`.

## Classification

| Surface | Classification | Evidence | Cleanup posture |
|---|---|---|---|
| `apps/gitboard` | Running | `package.json` has `dev`, `start`, `build:dashboard`; `src/index.ts` starts Bun server and GitHub poller | Keep as production/reference app until `apps/console` scaffold proves parity |
| Native systemd deploy | Running | `docs/deployment.md` documents `gitboard.service` with `HOST` and `PORT=3030` | Keep; this is the primary deploy path |
| Tailscale `:3030` URL | Running | `README.md`, `docs/deployment.md`, `docs/backend.md` describe tailnet access | Keep; use for live verification |
| GitHub poller/store | Running adapter | `src/index.ts` starts `GithubPoller` unless `SKIP_GITHUB_POLLER=1`; `src/api/routes/github.ts` mounted | Keep; durable external adapter, not temporary Beads bridge |
| Materializer core | Running bridge | `src/api/server.ts` creates `Materializer`, registers observability adapters, and starts trigger watchers | Keep; temporary bridge for Beads/specialists, durable shape only where upstream is external |
| Beads bridge tables/API | Running bridge | `/api/substrate`, `/api/feed`, `/api/console/graph`, `substrate_*` tables and materializer adapters | Keep but document as bridge/projection legacy until Substrate native state arrives |
| Specialists observability materialization | Running bridge | `observability-adapter.ts`, `/api/specialists`, `/api/specialists/jobs/:job_id/feed-events` | Keep; primary Console read path for specialist feed/metrics/evidence |
| `packages/core` | Shared package | Workspace package with `tsc` build and UI utilities | Keep; validate before scaffold copies more code |
| `packages/ui` | Shared package | Workspace package with React components/styles and Console token memories | Keep; future Console scaffold should reuse, not fork |
| `packages/api-client` | Shared package | Workspace package with API client build/test scripts | Keep; review usage during scaffold |
| `packages/html-preview` | Dormant/tooling | Has CLI package and README; `.worktrees/forge-a3m2-html-preview` exists but is ignored | Investigate before removal; likely tooling, not runtime |
| Dockerfile / Compose | Dormant reproduction path | README and `docs/deployment.md` mark Docker experimental/not primary | Keep dormant unless a follow-up decides to remove or refresh |
| `/beadboard` route/docs | Legacy compatibility | `server.ts` says frontend deprecated and `/beadboard` redirects to `/gitboard`; docs still cite removed `apps/beadboard` paths | Update docs; remove only after consumer count is zero |
| `apps/console` | Future migration target | `forge-9xet.2` exists but package is not present yet | Do not create in this inventory task |
| Tracked runtime artifacts | Cleanup candidate | `git ls-files` shows `apps/gitboard/data/audit.sqlite` and `apps/gitboard/logs/2026-05-19.jsonl` tracked despite ignore rules | Remove in a dedicated cleanup bead with rollback-safe validation |

## Runtime Entrypoints

- `apps/gitboard/src/index.ts`
  - Creates `GITBOARD_DATA_DIR` defaulting to `~/.agent-forge`.
  - Opens `gitboard.sqlite` for folding and `xtrm.sqlite` as current app state.
  - Starts `startServer(xtrmDb, { port })`.
  - Starts GitHub discovery/backfill/poller unless `SKIP_GITHUB_POLLER=1`.
- `apps/gitboard/src/api/server.ts`
  - Mounts `/health`.
  - Mounts `/api/github`, `/api/substrate`, `/api/specialists`,
    `/api/console/observability`, `/api/console/graph`, `/api/feed`,
    `/api/sources`, `/api/console/shell`, `/api/console/terminal`, and
    `/api/internal/*`.
  - Creates `Materializer`, `UnifiedScanner`, Beads trigger watcher,
    observability watcher, and optional parity harnesses.
  - Serves production dashboard assets under `/gitboard` and redirects `/` to
    `/gitboard`.

## Drift And Cleanup Candidates

1. Port defaults are inconsistent.
   - Live docs and systemd use `3030`.
   - `apps/gitboard/src/index.ts`, `startServer`, Dockerfile, and
     `docker-compose.yml` default to `3000`.
   - This should be fixed or explicitly documented as dev/container-only.

2. Environment variable names are inconsistent.
   - Runtime code uses `GITBOARD_DATA_DIR` for `gitboard.sqlite` and
     `xtrm.sqlite`.
   - Docker docs still mention `AGENT_FORGE_DB` and Compose sets `PROJECTS_DIR`,
     while scanners use `XDG_PROJECTS_DIR`.
   - `github-poller.ts` still has an `AGENT_FORGE_DB` standalone path fallback.

3. Backend docs are stale around Beadboard.
   - `docs/backend.md` still says Gitboard imports Beadboard control-plane code
     from `apps/beadboard`, but the current source tree has no top-level
     `apps/beadboard`.
   - `docs/backend-redesign.md` remains useful as historical redesign context,
     but several "current code" statements are now obsolete after the
     materializer/substrate bridge landed.

4. Tracked runtime artifacts should be removed carefully.
   - `apps/gitboard/data/audit.sqlite` is tracked.
   - `apps/gitboard/logs/2026-05-19.jsonl` is tracked.
   - `.gitignore` already ignores broad `data/`, `logs/`, `*.db`, and
     `*.log`, so this is likely historical residue.

5. Nested generated path should be investigated.
   - `apps/gitboard/apps/gitboard/tests/smoke/p2-beads-adapter.log` exists in
     the working tree but is not tracked.
   - It appears generated by smoke-test cwd behavior and should be covered by a
     follow-up if it recurs.

6. Docker is still present but not the winning deploy path.
   - It exposes `3000`, uses `/data/state.db`, and sets `PROJECTS_DIR`.
   - Treat as dormant local reproduction unless it is refreshed in a dedicated
     ops cleanup.

## Proposed Follow-Up Beads

- Normalize runtime/deployment defaults: reconcile `PORT`, `HOST`,
  `GITBOARD_DATA_DIR`, `AGENT_FORGE_DB`, and `XDG_PROJECTS_DIR`.
- Refresh backend docs: update stale Beadboard import/path claims and mark
  historical backend-redesign sections as superseded by the current bridge.
- Remove tracked runtime artifacts: untrack SQLite/log files and add a focused
  guard so generated runtime outputs do not re-enter source control.
- Classify dormant tooling: decide whether `packages/html-preview` and Docker
  stay as supported tooling, dormant tooling, or removal candidates.

## Next Execution Order

1. Run the cleanup guard/test bead (`forge-benk.5`) so the baseline checks are
   explicit.
2. Start TypeScript baseline burn-down (`forge-benk.2`) with the drift above in
   mind.
3. Audit app/materializer/API separation (`forge-benk.3`) using this inventory
   plus `docs/architecture/console-telemetry-materialization.md`.
4. Prepare the `apps/console` scaffold gate (`forge-benk.4`) only after the
   runtime and documentation drift is visible.
