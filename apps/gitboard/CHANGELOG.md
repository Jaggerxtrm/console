# Changelog

All notable changes to Agent Forge are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)

## [Unreleased]

### Added
- **Operational console graph view** — `/console/graph` redesigned around partitioned clusters (`partitionGraph` over `STRUCTURAL_EDGE_TYPES`): WIP strip → cluster panes → orphan sidebar → state buckets. Variable-width HTML chip nodes, edge labels per relationship type, header pill toggles (parent-child / related / deferred). Fixed-height column with internally-scrolling regions and a pinned-bottom info foot.
- **Shared-server Dolt routing in `project-scanner`** — detects `dolt.shared-server: true` in `.beads/config.yaml`, reads the port from `~/.beads/shared-server/dolt-server.port`, and uses `metadata.json`'s `dolt_database`. Repos like `~/dev/specialists` that don't run their own sql-server now resolve correctly.

### Fixed
- **`/api/console/graph` hung past 30 s on large repos** — `DoltClient.getIssues` now batches dependency + label hydration into two `WHERE issue_id IN (…)` queries instead of running 2 sub-queries per row. Total query count is constant (3) regardless of `limit`; previously a `limit=1000` request fired 2000+ MySQL round-trips.
- **Specialist "Last output" was empty everywhere** — `observability/dao.ts` now `SELECT`s `last_output` from `specialist_jobs` (with a `PRAGMA table_info` probe to gracefully fall back to `NULL` on older schemas). Restores excerpts in the cockpit `ChainDetailPane`, inline dossier `· N runs` section, `SpecialistChainGraph`, and bottom-drawer Specialists tab.
- **Observability watcher hot-loop** — schema-incompatible `.specialists/observability.db` files were being re-probed on every mtime tick (sp processes write continuously), burning 90 %+ CPU and starving the API. `dead`-cache moved to module scope (survives the 2 s TTL pool recreations in `api/routes/specialists.ts`) and keyed by repo slug, not alias. Structural failures (missing `specialist_jobs` table, schema-version mismatch, attach failure) now stay cached for the process lifetime.
- **Graph edge arrowheads detached from card edges** on reverse and same-layer edges — SVG marker geometry fixed (`markerUnits="userSpaceOnUse"`, `refX` inside `markerWidth`); cross-layer-reverse routing now uses the target node's width.
- **Graph viewport organization** — deep clusters no longer push the orphan sidebar past the buckets/foot. `.g-app` is now a fixed-height flex column with `overflow: hidden`; clusters and orphans scroll independently; buckets and foot are pinned at the bottom.

## [0.7.2] — 2026-03-08

### Decisions
- Sidebar detail accordion deferred: event detail will live in ActivityTimeline accordion (T7) only; sidebar stays a clean repo list (2026-03-07)
- ContributionHeatmap integration deferred to v0.8.0: component kept in codebase but not wired up; right-panel removed, 2-column layout in place (2026-03-07)

### Added
- **OmniForge rename** — display name updated across package.json, index.html, App.tsx, docker-compose.yml
- **Inline commit accordion (T7)** — PushEvent rows expand to show full commit list; each commit has SHA link → subject → collapsible `message_full` body (Radix Collapsible); soft cap 20 lines + "Show N more"; `commitBodyLines` + `COMMIT_BODY_SOFT_CAP` exported and unit-tested
- **Resizable sidebar** — drag handle on right edge, 160–480px range, width persisted in localStorage
- `docs/omniforge-architecture.md` — full guide for splitting into `forge-core` / `gitboard` / `forge` multi-repo structure under the `omniforge` GitHub org

### Changed
- **GithubPanel** — 2-column layout (sidebar + timeline); WatchEvent/ForkEvent/MemberEvent filtered into collapsed "★ N starred this week" strip at bottom; EventDetail right panel removed; `lastEventAt` derived from `ownEvents` and passed to sidebar for sorting
- **StatsHeader** — tightened to 32px single-line bar; octicons per stat (CalendarIcon, UploadIcon, GitPullRequestIcon, GitCommitIcon, RepoIcon); monospace numbers
- **RepoSidebar** — renamed header to "REPOS" (32px, matches StatsHeader); shows only `ownerUsername/*` repos (derived from event actor); sorted by most recent own event descending; relative timestamps per repo (Xm ago / Xh ago / yesterday / Xd ago); exports `filterOwnRepos`, `sortByLastEvent`, `relativeTime` (all unit-tested)
- **ActivityTimeline** — replaced Radix Accordion outer trigger (unreliable with `asChild` + div) with direct manual toggle; `measureElement` + `data-index` added to virtualizer for dynamic row heights; clicking a PushEvent row both selects and toggles commit list; chevron rotates when expanded
- ROADMAP.md — items 2 (heatmap), 5 (sidebar detail) marked as deferred with decisions recorded

### Removed
- EventDetail right-panel slide-in — detail now lives in ActivityTimeline accordion only
- RepoFilter.tsx and CommitList.tsx — replaced by RepoSidebar and EventDetail (from v0.7.1)

## [0.7.1] — 2026-03-07

### Added
- RepoSidebar component — grouped repo list with 24h stats, unread dots, GitHub links (replaces RepoFilter)
- EventDetail component — slide-in panel with diffstat bar, expandable commit messages, message_full lazy enrichment (replaces CommitList)
- GET /api/github/repos/stats route — 24h push/PR counts per repo
- getRepoStats, isTruncated, updateCommitFullMessage, enrichCommitMessages to github-store
- repoStats and unreadRepos state + setRepoStats, markRepoUnread, clearRepoUnread actions to Zustand store
- message_full column migration and GithubCommit.message_full type field
- ROADMAP.md — v0.7.2 UX overhaul items
- GitHub Events enrichment: GithubPoller now calls Compare API for PushEvents (full commit list + aggregate diff stats) and PR API for PullRequestEvents (title, body, additions, deletions, changed_files)
- Makefile: Docker lifecycle targets (up/down/build/rebuild/restart/logs/shell/clean/prune) auto-resolving GITHUB_TOKEN from gh auth token, configured for rootless Podman

### Changed
- GithubPanel — three-column layout: RepoSidebar | activity feed | EventDetail slide-in
- ActivityTimeline — day group headers, inline diffstats, branch tag, PushEvent chevron
- ContributionHeatmap — month labels row, 14px cells, 3px gap, day-of-week labels
- globals.css — full LobsterBoard design token system replacing ad-hoc slate-* classes
- useGithubActivity hook — loads repoStats on mount, marks repos unread on WebSocket new_event
- insertCommit now persists message_full at insert time; updateEventEnrichment added to github-store

### Removed
- RepoFilter.tsx and CommitList.tsx — replaced by RepoSidebar and EventDetail
