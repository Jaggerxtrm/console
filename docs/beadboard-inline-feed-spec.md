# Beadboard Inline Feed Redesign Spec

## Status

Draft for `forge-efx`. This captures the current product/design decisions before implementation.

## Problem

The current Beadboard UI is primarily a generic Kanban board. It does not feel native to the Gitboard/FUI operational console, does not support fast cross-repo issue navigation well, and does not provide a first-class way to open rich issue details inline. The desired direction is a Beads issue intelligence surface: dense, priority-aware, repo-switchable, and expandable in place like the Git feed and Pull Request conversation view.

## Goals

- Make the primary Beadboard surface an inline issue feed, not Kanban.
- Preserve Kanban as a secondary overview/state-map mode.
- Provide fast repo/project switching with open/in-progress/blocked counts.
- Show issues ordered by operational priority and status.
- Distinguish epics clearly from ordinary executable issues.
- Expand issue details inline without hover-only interactions or modal dependence.
- Keep visual language coherent with the Gitboard Westworld/Delos-inspired FUI: graphite/navy, thin technical borders, restrained cyan accents, no emojis, iconography via Octicons or matching line icons.
- Keep first implementation read-oriented; mutating actions can follow after detail fidelity is stable.

## Non-goals

- Do not remove Kanban.
- Do not implement destructive issue actions in the first pass.
- Do not copy the old Beadboard card styling.
- Do not use hover overlays as the primary detail interaction.
- Do not modify reference repos `~/dev/beads-viewer` or `~/dev/beads_viewer`.

## Current implementation evidence

### Gitboard / Beadboard app

- `apps/beadboard/src/dashboard/App.tsx` currently has tabs `issues`, `closed`, `memories`, with `issues` rendering `KanbanBoard` directly.
- Project switching exists in a sidebar but is basic: project rows only show `project.name`, and stats are computed from the loaded selected project.
- `apps/beadboard/src/api/routes/beads.ts` exposes:
  - `GET /projects`
  - `GET /projects/:id/issues`
  - `GET /projects/:id/issues/closed`
  - `GET /projects/:id/memories`
  - `GET /projects/:id/interactions`
  - `GET /projects/:id/stats`
  - `GET /projects/:id/connection`
- `apps/beadboard/src/core/project-scanner.ts` discovers projects by recursively scanning configured roots for `.beads/`, reading `.beads/metadata.json`, and extracting Dolt port/database hints from `.beads/config.yaml`.
- `apps/beadboard/src/core/beads-reader.ts` reads `issues`, dependencies from `dependencies`, labels from `issue_labels`, memories from `knowledge.jsonl`, and interactions from `interactions.jsonl`.
- `apps/beadboard/src/types/beads.ts` already models `BeadIssue`, `BeadDependency`, `Memory`, `Interaction`, and `BeadsProject`, but issue detail is not currently first-class.

### Reference: `~/dev/beads-viewer`

- `server/index.ts` is a CLI-backed viewer using `bd --json` for issue operations and a WebSocket watcher on `.beads/issues.jsonl`.
- `server/utils/bd-cli.ts` wraps `bd list`, `bd show`, `bd ready`, `bd blocked`, `bd create`, `bd update`, and `bd close`.
- Its `BdIssue` type includes richer fields than current Beadboard types: `design`, `acceptance_criteria`, `assignee`, `external_ref`, `dependents`, and `dependencies`.
- Useful lesson: detail fidelity is best provided by `bd show`/equivalent issue-detail expansion, not just list rows.

### Reference: `~/dev/beads_viewer`

- `README.md` describes the core UX as a split-view dashboard: fast list plus rich details, with Kanban (`b`) as a secondary flow view.
- `internal/datasource/source.go` implements multi-source discovery with explicit source priority: Dolt > SQLite > worktree JSONL > local JSONL.
- `internal/datasource/load.go` selects the best non-empty valid source and falls back to JSONL if smart discovery fails.
- `internal/datasource/sqlite.go` handles schema variation, including labels as either an issue column or a separate labels table, and reads fields such as design, acceptance criteria, notes, source repo, external refs, compaction metadata, and labels.
- Useful lesson: Beadboard should not assume only live Dolt port connectivity. A robust source model should expose source type, freshness, validity, and issue counts per project.

## Proposed product model

### Top-level layout

```text
Beadboard
├─ Left rail: repo/project switcher
├─ Center: issue feed / board / closed / memories
└─ Inline expansion inside center feed
```

The left rail should be treated as a system partition list, mirroring Gitboard’s repo rail but tuned for Beads.

### Tabs

Replace current `Issues` semantics with explicit modes:

1. `Feed` — primary, inline expandable issue list.
2. `Board` — Kanban overview, secondary.
3. `Closed` — closed issue feed.
4. `Memories` — existing memory view, restyled.

### Project / repo switcher

Each project row should show:

- project/repo name
- status: active / idle / error / source stale
- open count
- in-progress count
- blocked count
- epic count or active epic count
- last scanned / source freshness

Selection behavior:

- Clicking a project switches the feed to that project’s open work.
- The selected project should be visible in the top chrome and sidebar.
- Future search/palette can provide fuzzy project switching, but sidebar is first priority.

### Feed ordering

Default feed order must be operational, not just chronological:

1. `in_progress`
2. open and unblocked, priority 0 → 4
3. `blocked`
4. deferred/backlog if represented by priority/status/label
5. closed hidden from primary feed unless requested

Within groups:

```text
priority asc → updated_at desc → created_at desc
```

If dependency data is available, ready/unblocked issues should rank above blocked issues of the same priority.

### Issue row content

Each issue row should show:

- issue ID
- title
- status pill
- priority pill
- issue type icon/pill
- owner/assignee
- updated time
- dependency indicators
- label chips
- agent/model marker when interactions exist

Status distinction:

- `in_progress`: active cyan edge/state.
- `open`: neutral ready state.
- `blocked`: amber/red guarded state.
- `closed`: desaturated archived state.
- deferred/backlog: muted graphite state. If Beads has no explicit `deferred`, infer from priority 4, label, or future metadata.

### Epic distinction

Epics should not look like ordinary rows with only a pill.

Epic row behavior:

- Stronger section-like row treatment.
- Show child/dependency count.
- Show completion ratio when children can be inferred.
- Expand epic inline to show its child/blocked/dependent issues.
- Use a distinct icon and typography treatment.

Epic semantics:

- Epic = orchestration object / parent process.
- Task/bug/feature/chore = executable unit.

Data needed:

- `issue_type = 'epic'` is already available.
- Parent/child edges are not fully mapped in current reader; dependencies currently only query `from_issue -> to_issue` as dependencies. Need dependents/reverse edges and parent/discovered-from relationship handling.

### Inline expanded issue detail

Clicking an issue expands a full inline dossier below the row.

Expanded sections:

1. Compact summary
   - status, priority, type, owner, created/updated/closed, labels.
2. Description
   - full issue description, no internal scroll box.
3. Dependency graph summary
   - blocked by
   - blocks
   - related
   - parent/children
   - discovered-from
4. Comments / notes / history
   - source depends on available schema / `bd show` output / events tables.
5. Interactions
   - agent/model/tool interactions from `.beads/interactions.jsonl`.
6. Memories
   - memory entries linked by issue ID where available.
7. Suggested command hints
   - read-only first: `bd show <id>`, `bd update <id> --claim`, etc.
   - actual mutating buttons should be a later phase.

Avoid:

- modal-first detail.
- hover-only detail.
- internal scrolling boxes for main text.

### Kanban refresh

Kanban remains useful as a flow overview but should become secondary.

Requirements:

- Keep columns by status.
- Restyle cards to the same FUI visual system.
- Card click expands inline or opens a consistent detail surface.
- Epic cards should show progress and child count.
- The board should respect project selection and filters.

## Data/API requirements

### New/expanded API endpoints

Current endpoint `GET /projects/:id/issues` is list-oriented. Add a detail endpoint:

```text
GET /api/beads/projects/:projectId/issues/:issueId/detail
```

Suggested response:

```ts
interface BeadIssueDetail {
  issue: BeadIssue;
  dependencies: BeadDependency[];
  dependents: BeadDependency[];
  related: BeadDependency[];
  children: BeadIssue[];
  comments: BeadComment[];
  events: BeadEvent[];
  interactions: Interaction[];
  memories: Memory[];
  source: BeadsSourceInfo;
}
```

Add project summary endpoint or enrich existing `/projects`:

```ts
interface BeadsProjectSummary extends BeadsProject {
  counts: {
    open: number;
    in_progress: number;
    blocked: number;
    closed: number;
    epics: number;
    ready: number;
  };
  source: BeadsSourceInfo;
}
```

Add source info:

```ts
interface BeadsSourceInfo {
  type: 'dolt' | 'sqlite' | 'jsonl_worktree' | 'jsonl_local';
  path: string;
  valid: boolean;
  issueCount: number;
  modTime: string;
  priority: number;
  error?: string;
}
```

### Reader improvements

Current `BeadsReader` should be extended to fetch:

- reverse dependencies / dependents.
- parent/child or discovered-from edges if represented in `dependencies.dependency_type`.
- comments/events/history if tables exist.
- richer issue columns where available: design, acceptance criteria, notes, external refs, assignee, source repo.

The reference `beads_viewer` shows schema variation is real. Implementation should handle optional columns defensively rather than assuming one schema.

### Source discovery improvements

Current `ProjectScanner` assumes Dolt port in config and returns no issue counts. Use `beads_viewer` source-priority model as design inspiration:

1. Discover `.beads/dolt` as canonical when available.
2. Discover SQLite `.beads/*.db` if present.
3. Discover `.beads/issues.jsonl` or equivalent JSONL exports.
4. Discover worktree JSONL sources if needed.
5. Validate source and expose issue count/freshness.

This lets the UI show repos even when Dolt server is not running, and it gives clear source health in the rail.

## Component plan

Create new components under `apps/beadboard/src/dashboard/components/beads/`:

- `IssueFeed.tsx`
- `IssueRow.tsx`
- `IssueExpandedBody.tsx`
- `IssueStatusPill.tsx`
- `IssuePriorityPill.tsx`
- `EpicIssueRow.tsx`
- `ProjectRail.tsx`
- `ProjectRailRow.tsx`
- `DependencyStrip.tsx`
- `IssueConversation.tsx`

Refactor existing:

- `KanbanBoard.tsx` remains but becomes the `Board` tab.
- `App.tsx` owns mode switching and project selection, or delegates shell layout to `BeadboardShell`.

## Styling plan

Use the Gitboard FUI system as the baseline:

- same graphite/navy surfaces.
- same thin borders and cyan edge states.
- same row density and inline expansion pattern as PR feed.
- no emojis.
- icons via `@primer/octicons-react` or an equivalent coherent line set.

Status/icon suggestions:

- epic: project/milestone-style icon.
- bug: issue-opened/alert icon.
- feature: plus/project icon.
- task/chore: checklist/tools icon.
- blocked: blocked/stop icon.
- closed: check icon.
- in progress: pulse/dot/clock-like icon.


## Detailed repository exploration findings

### `~/dev/beads-viewer`

This repo is a small React/Express Beads web viewer. It is valuable mostly as a cautionary migration source, not as a visual target.

Useful patterns:

- `server/index.ts` exposes a simple REST/WS surface around `bd --json`: list, show, ready, blocked, create, update, close.
- `server/utils/bd-cli.ts` treats `bd show` as the rich-detail source and `bd list` as the fast-list source. This matches the desired Beadboard split: feed rows from list data, expanded dossier from detail data.
- `src/store/useIssueStore.ts` uses optimistic updates and WebSocket refresh events. This is useful later for mutating actions, but the first Beadboard pass should stay read-oriented.
- `src/lib/jsonl.ts` has simple ready/blocked derivation: an open issue is ready when no open/in-progress/blocked blocker exists. This logic can be reused conceptually for feed ranking.
- `src/types/issue.ts` includes fields missing or incomplete in current Beadboard UI: `design`, `acceptance_criteria`, `notes`, `estimated_minutes`, `external_ref`, dependents, and typed dependency kinds.

Anti-patterns to avoid:

- `IssueList.tsx` opens details in a side panel, not inline. This conflicts with the Gitboard feed pattern.
- `IssueSidePanel.tsx` auto-saves on backdrop/Escape in edit mode. That is too risky for the xtrm console; any mutation should be explicit.
- Multiple components use emoji labels/icons (`IssueSidePanel`, `KanbanBoard`, dependency labels). Gitboard styling requires Octicons/line icons and no emojis.
- `DependencyGraph.tsx` hard-codes `http://localhost:3001/api/issues?includeDeps=true`; avoid this in Beadboard by keeping relative API calls through the app server.

### `~/dev/beads_viewer`

This repo is the stronger architectural reference. It is a graph-aware TUI/robot engine rather than a web UI clone, and it models the intelligence Beadboard should surface visually.

Useful data model findings:

- `pkg/model/types.go` supports more statuses than current Beadboard: `open`, `in_progress`, `blocked`, `deferred`, `draft`, `pinned`, `hooked`, `review`, `closed`, `tombstone`. Beadboard should not hard-code only four statuses.
- The same model includes `Design`, `AcceptanceCriteria`, `Notes`, `EstimatedMinutes`, `DueDate`, `ExternalRef`, compaction metadata, labels, dependencies, comments, and `SourceRepo`. These should inform the issue detail schema.
- Dependency types include `blocks`, `related`, `parent-child`, and `discovered-from`. Empty dependency type is treated as blocking for backward compatibility.
- `internal/datasource/source.go` gives an authoritative source priority model: Dolt > SQLite > worktree JSONL > local JSONL. Current Beadboard only really succeeds when Dolt port data is available.
- `internal/datasource/load.go` filters out empty sources and then selects the best source by priority, not freshness alone.
- `internal/datasource/sqlite.go` probes schema variation, especially labels as either `issues.labels` or a separate `labels` table. Current Beadboard should adopt optional-column/schema-probing instead of assuming a single table layout.
- `pkg/loader/loader.go` prefers `BEADS_DB`, then `BEADS_DIR`, then local `.beads`, and handles worktree-vs-main-repo `.beads` fallback. This matters for xtrm worktree sessions.

Useful intelligence/UI concepts:

- The README frames the core experience as “fast list + rich details”; Kanban is explicitly secondary. This validates the feed-first Beadboard direction.
- `pkg/analysis/triage.go` defines a high-value robot payload: quick ref, recommendations, quick wins, blockers to clear, project health, graph health, velocity, and command helpers. Beadboard can progressively surface these as rail counters and feed badges.
- `docs/bead-history-feature-plan.md` designs bead-to-commit correlation. Later Beadboard detail expansion should reserve space for code/commit correlations.
- `docs/labels-view-feature-plan.md` treats labels as graph overlays, not just chips. Later Beadboard project/detail views can show label health and cross-label blocking.
- `docs/complementary-features-analysis.md` identifies multi-repo aggregation, unified triage, proactive alerts, and graph visibility as natural extensions. These map well to future Beadboard phases.

### Current Beadboard gaps confirmed by exploration

- `apps/beadboard/src/dashboard/App.tsx` has only `issues`, `closed`, and `memories` tabs; `issues` renders `KanbanBoard`. There is no primary feed.
- The project rail shows project names only. It does not show counts, source health, active issues, blockers, or freshness.
- `getAgentForIssue()` exists in `App.tsx`, but `KanbanBoard` is called without `getAgent`, so cards currently cannot display agent badges even though `BeadCard` accepts them.
- `BeadCard.tsx` and `AgentBadge` use emojis and should be replaced with coherent line icons.
- `BeadCard.tsx` only summarizes dependencies/labels; no detail expansion exists.
- `BeadsReader.getIssues()` sorts by `priority ASC, created_at DESC`, but it does not group by operational status (`in_progress`, ready/open, blocked, deferred).
- `BeadsReader.getDependencies()` only reads outgoing dependencies for an issue. Inline dossiers need reverse dependencies/dependents and parent/child/discovered-from interpretation.
- `getClosedIssues()` does not hydrate labels/dependencies, so closed issue detail would be weaker than open issue detail.
- `ProjectScanner` sets `issueCount: 0` and marks status as `active` only from a configured Dolt port. It does not validate source availability or expose source type/freshness.
- `apps/beadboard/src/types/beads.ts` currently lacks `deferred`, `draft`, `review`, `pinned`, `hooked`, `tombstone`, comments, notes, design, acceptance criteria, due date, estimated minutes, external refs, source repo, and source metadata.

## Implementation phases

### Phase 1 — Spec and API proof

- Add this spec.
- Add issue detail endpoint with dependencies, dependents, interactions, and memories.
- Add project summaries/counts.
- Add defensive optional-column probing for richer Beads fields.

### Phase 2 — Feed UI

- Add `Feed` tab as primary.
- Implement project rail with counts.
- Implement sorted `IssueFeed` and inline expansion.
- Implement clear epic styling.

### Phase 3 — Detail completeness

- Hydrate comments/history/notes when available.
- Show dependency/dependent graph inline.
- Show linked interactions/memories.
- Add source-health and partial-data states.

### Phase 4 — Kanban refresh

- Restyle board.
- Make card detail interaction coherent with feed.
- Keep board secondary.

### Phase 5 — Actions

After read-only UX is stable:

- claim issue.
- add note.
- close issue.
- mark blocked.
- copy command / open CLI hint.

Mutating actions must be explicit and safe.

## Open questions

- How should `deferred` be represented if Beads has no first-class deferred status? Proposed answer: priority 4 or a label until schema support exists.
- Which dependency types are guaranteed in Dolt schema across current Beads versions? Need inspect live schema and `bd show --json` examples.
- Should project switching include all discovered `.beads` projects or only those with non-empty valid sources? Proposed answer: show all, but sort valid/non-empty first and mark invalid/empty clearly.
- Should the feed support multi-project aggregation? Proposed answer: later; first pass uses one selected project to keep interactions predictable.
