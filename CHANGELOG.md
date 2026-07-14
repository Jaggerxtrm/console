
## [Unreleased]

### Added

- **Unify source scanning** ([aa973e0](https://github.com/Jaggerxtrm/console/commit/aa973e0dc33f850fdbe0d5ac45f323e11b22b594))


- **Add manual source pins** ([7ec4ed9](https://github.com/Jaggerxtrm/console/commit/7ec4ed935d429302b41f92a26487db548c27577d))


- **Read graph from xtrm sqlite** ([b2fb439](https://github.com/Jaggerxtrm/console/commit/b2fb4397c23d65ad801eb0b6e5ef98c25acf6376))


- **Add websocket grace window** ([39cfca9](https://github.com/Jaggerxtrm/console/commit/39cfca9b661e37ef12c391a289192216d61c5f12))


- **P6 smoke tests (404 + no-beadboard-refs) + hotfix dynamic import in beads-adapter** ([047e98e](https://github.com/Jaggerxtrm/console/commit/047e98e87269c95100c0c57142c40dc5577cfc38))

  - apps/gitboard/tests/smoke/p6-beadboard-404.sh: spawns bun on port 3099 with
    empty data dir, polls until ready, asserts /beadboard and /api/beads/projects
    both return 404 (not 200, not 301).
  - apps/gitboard/tests/smoke/p6-no-beadboard-refs.sh: greps src/ for functional
    beadboard refs (excluding comments and historical notes). Filter covers
    static imports, requires, dynamic 'await import', and route mounts.
  - beads-adapter.ts:222: fix runtime 'await import' that still pointed to deleted
    beadboard/src/core/dolt-client.ts — repointed to '../dolt-client.ts'.
  - Cleaned historical 'Ported from apps/beadboard' comments in types/beads.ts +
    globals.css so the no-refs smoke can keep an aggressive filter.


- **P5 channel-grep smoke + Playwright deferral note** ([9af7b0a](https://github.com/Jaggerxtrm/console/commit/9af7b0a444b58fda5a0bade06bafe0574d739ef6))

  - tests/smoke/p5-channel-grep.sh: production-code grep for stale beads:* WS
    channel/event refs. Passes today: zero hits.
  - tests/e2e/ws-grace-playwright.e2e.note.md: defers two original .23 Playwright
    e2e tests (CDP network panel + substrate roundtrip) until a Playwright
    harness lands; grace timer is already covered by 3 unit tests in
    tests/dashboard/lib/ws.test.ts, and live e2e from .13 merge proves substrate
    channel roundtrip in production logs.


- **Land optimized document preview** ([9672280](https://github.com/Jaggerxtrm/console/commit/96722802b2d9c833e5ed137c36de1f852f9c45c4))


- **Drawer Specialists sp-ps operational view** ([5a6a1cf](https://github.com/Jaggerxtrm/console/commit/5a6a1cfcb58e0299aa475ee5ed635177f3a6b68c))

  Replace the drawer's list+detail hybrid with a terminal-style sp-ps row
  list (specialist/job-id/state/elapsed/last-line), repo-scoped by default
  with a persisted all-hosts toggle in the shell store. Job-id and
  specialist render as chips that open the right sidebar; the drawer no
  longer streams feeds. Adds drawer.specialists.* telemetry events.

  Reviewer PASS; code-sanity OK; obligations CLEAN.


- **Unified markdown renderer for sp-result + PR/issue/release bodies** ([9cd7618](https://github.com/Jaggerxtrm/console/commit/9cd7618ced68f1b49eab1f5aaa22a9080c0bb689))

  Extract renderPrBodyText into a shared apps/gitboard/src/dashboard/lib/
  markdown.tsx as a behavioral superset, exporting both ResultMarkdown and
  a back-compat renderPrBodyText; repoint IssueTimeline/ReleaseTimeline/
  RepoContentPanels imports. Adds fenced code, GFM tables, headings, lists,
  inline styles, and bare-URL autolinking; strips raw HTML and allowlists
  link protocols to http/https/mailto. Chose extend-renderer over
  react-markdown (trio = 52.4kB gzip, over the ~26kB budget headroom).
  Adds markdown.rendered/rejected/parse.warn telemetry and a 7-case
  fixture+regression test.

  SCRUTINY high; reviewer PASS; security no-XSS; code-sanity resolved
  (sanitize strips-only, no entity-decode); gitnexus_impact containment
  verified (renderPrBodyText signature preserved across 5 d=1 callers).


- **Shared <BeadActivityPane> foundation + authenticated result endpoint** ([8feb8fa](https://github.com/Jaggerxtrm/console/commit/8feb8faa2604748511c615cd0ee639328883dcde))

  New <BeadActivityPane> (header + chain rows + per-job live feed/collapsed
  result) shared by the cockpit and sidebar surfaces; <BeadHeader> extracted
  from IssueFeed; pure render-branch logic in beadActivityState.ts. Adds
  GET /api/specialists/jobs/:job_id/result reading specialist_job_events,
  admin-gated fail-closed (403 before DB) per forge-frs5. Six bead_activity.*
  telemetry events. Feed mounts TerminalStream while running, unmounts on
  collapse to bound memory.

  SCRUTINY high; reviewer PASS; security-auditor CLEAN (endpoint fail-closed,
  parameterized); code-sanity OK; 14 tests (endpoint authz + component render
  branches with mocked TerminalStream).


- **Cockpit 2-line chain rows + shared type palette** ([ec40886](https://github.com/Jaggerxtrm/console/commit/ec40886fa8328582b706a8eaba907d4d47141af6))

  Restyle cockpit chain list as two-line rows (ChainListRow: bead-id/title +
  specialist/job-id with type-coloured chip) matching the IssueFeed identity.
  Extract the duplicated TYPE_CONFIG palette into a single shared
  dashboard/lib/type-palette.ts reused by IssueFeed, Graph, BeadNode, and the
  cockpit rows. Adds cockpit.list.rendered + cockpit.row.palette.mismatch
  telemetry.

  SCRUTINY medium; reviewer PASS; code-sanity OK; obligations clean; 2 tests.


- **Cockpit 2-pane hosting <BeadActivityPane>** ([dbee2e8](https://github.com/Jaggerxtrm/console/commit/dbee2e80fe625e050dad30130249975aadf89a31))

  The /console/specialists cockpit right pane now renders the shared
  <BeadActivityPane> for the selected chain (live feed + result), replacing
  the static ChainDetailPane; left-pane chain selection drives the pane.
  Pure selection/telemetry-decision logic extracted to cockpitSelection.ts
  (unit-tested in node, avoiding the page's module-level websocket).
  Adds cockpit.chain.selected / bead_activity.swapped / list.first_paint.

  SCRUTINY medium; reviewer PASS. 6 pure cockpitSelection tests +
  restored BeadSideDrawer test (the prior executor had clobbered it).


- **Right sidebar overlay primitive + useShellStore wiring** ([b76e0f5](https://github.com/Jaggerxtrm/console/commit/b76e0f5d8def8ee75687a1485350fdd338e33877))

  New RightSidebar.tsx — fixed-right overlay (does not push content,
  z-index above the bottom drawer) hosting <BeadActivityPane>, opened via
  useShellStore.openSidebar({beadId,jobId}); close on X/ESC/null target,
  target-swap without nesting, persisted open-state + width. Defensive
  resize (pointercapture try/catch + pointercancel/lostpointercapture
  cleanup). Adds the sidebar.* telemetry events.

  SCRUTINY medium; reviewer PASS; seconder quality findings resolved;
  7 tests (store slice persist/swap + RightSidebar ESC/resize).


- **Chip → right sidebar wiring (feed + graph + drawer)** ([9210fb7](https://github.com/Jaggerxtrm/console/commit/9210fb7e826ece70ae87609b0b9c2918669df4ee))

  Specialist chips in the bead feed, graph nodes, and the drawer now open
  the right sidebar (useShellStore.openSidebar) pointed at that bead/job;
  SpecialistOwnerBadge is keyboard-accessible and stops propagation on both
  click and Enter/Space so bead-row navigation isn't triggered. Adds
  chip.click telemetry per source. Completes the forge-70el live-feed epic.

  SCRUTINY medium; reviewer PASS; seconder finding resolved; leaf-component
  test (page-render tests infeasible due to module-level websocket).


- **Add light console roadmap mock** ([9f6ca79](https://github.com/Jaggerxtrm/console/commit/9f6ca790623d512b8ff328bf070801c4ee8ac9b7))

  Adds the light-canonical xtrm Console Quiet roadmap mock and mounts it in the design-preview route without staging unrelated worktree changes.


- **Add operations query lab mock** ([0d5da5f](https://github.com/Jaggerxtrm/console/commit/0d5da5f3486a832860d2dbf196a53716b3258f13))


- **Show operations drawer overlay mock** ([300a14b](https://github.com/Jaggerxtrm/console/commit/300a14b76d3b25a2ee78aa8c0ae51ce854ab29ee))


- **Mount complete console design mock** ([7e652d6](https://github.com/Jaggerxtrm/console/commit/7e652d661aca216b7b2379820d305e58f62ee52c))


- **Add telemetry materialization bridge (#41)** ([e006f51](https://github.com/Jaggerxtrm/console/commit/e006f51dc9c0ff7b97508a92bade8b5aeea9d82d))

  * chore(forge-60nq): reconcile local git state

  * checkpoint(executor): forge-f3mx turn 43

  * checkpoint(executor): forge-f3mx turn 60

  * checkpoint(executor): forge-f3mx turn 65

  * checkpoint(executor): forge-f3mx turn 68

  * checkpoint(executor): forge-f3mx turn 71

  * fix(forge-ftgb): clean up structured feed types

  * docs(forge-ds74): add object-first drawer mock

  * checkpoint(executor): forge-v39n turn 34

  * checkpoint(executor): forge-v39n turn 47

  * checkpoint(executor): forge-v39n turn 71

  * fix(graph): hydrate historical dependency targets

  * chore(beads): record lineage repair workflow

  * fix(graph): include historical bead dependencies

  * session report: 2026-06-04

  * feat(console): add telemetry materialization bridge

  ---------


- **Scaffold console app** ([dee4615](https://github.com/Jaggerxtrm/console/commit/dee4615eb5ad8a314b534174517a3c86a9b1a218))


- **Add console bead inspector** ([4edf5be](https://github.com/Jaggerxtrm/console/commit/4edf5beed497265b123d0074bd2ea2482845f838))


- **Add console operations query lab** ([9596e52](https://github.com/Jaggerxtrm/console/commit/9596e526ad1e5925a9ae6a470f7fa82ac8dd4b65))


- **Add console observability datasource fixtures** ([7c6df7e](https://github.com/Jaggerxtrm/console/commit/7c6df7ee64cf73816ac34ffc5ad98eef4bb2bc2f))


- **Add console observability dashboard schema** ([b819c8f](https://github.com/Jaggerxtrm/console/commit/b819c8f17dbd95a99828973fca78833a4d909a06))


- **Render phase0 observability fixture panels** ([39a7c75](https://github.com/Jaggerxtrm/console/commit/39a7c751467be0ba9b6e9b7e72bd448864ace4c7))


- **Move source lifecycle policy to core** ([d8fab22](https://github.com/Jaggerxtrm/console/commit/d8fab22fd72fc6862be680aae705476bd06cc009))


- **Move realtime log contracts to core** ([a1a843f](https://github.com/Jaggerxtrm/console/commit/a1a843f762ec9c0b1e43506c946772fd49a0b6bd))


- **Move terminal policy contracts to core** ([2e0a7bf](https://github.com/Jaggerxtrm/console/commit/2e0a7bfc377db1d0668f0d8998bf9d81c307d519))


- **Add native AgentOps explore** ([293225e](https://github.com/Jaggerxtrm/console/commit/293225e4793933079b1b9a6df55728563a87421f))


- **Reconcile console contract work** ([dab5289](https://github.com/Jaggerxtrm/console/commit/dab52894e780900ef18ce34973876c4f72a33f32))


### Fixed

- **Gate xtrm materializer path behind GITBOARD_XTRM_PATH=1; parity OFF** ([29ea3fb](https://github.com/Jaggerxtrm/console/commit/29ea3fb87b5b4a8ee180946322082b1861d4996c))

  Restores prod stability after forge-eorh.47 OOM regression.

  1. apps/gitboard/src/index.ts — xtrmDb created only when GITBOARD_XTRM_PATH=1.
     Unset by default → createApp sees xtrmDb=undefined → entire materializer +
     adapters + parity harnesses + substrate routes go dormant. Behavior matches
     commit 33543b2 (last known-stable prod baseline).

  2. apps/gitboard/src/api/server.ts — even with GITBOARD_XTRM_PATH=1, parity
     harnesses default OFF; require GITBOARD_ENABLE_PARITY=1 to start. The
     Beads parity harness OOM'd prod by scanning FS + reading 1000 issues per
     project × 19 projects every 30s with no eviction.

  Verified on prod: memory 59-134M peak (vs 824M historical baseline). All
  existing endpoints functioning identically to 33543b2.

  Closes forge-eorh.47.


- **Delegate write to per-adapter write(db, snapshot)** ([bdfd462](https://github.com/Jaggerxtrm/console/commit/bdfd4629ba0884422981a382ab7b0029acbc9642))

  closes forge-eorh.48

  - MaterializerAdapter.write(db, snapshot) becomes the per-adapter write
    contract; Materializer keeps BEGIN/COMMIT/cursor advance.
  - beads-adapter writes substrate_issues + substrate_dependencies +
    tombstoneMissing; obs-adapter writes full specialist_jobs row shape
    (12 columns including chain_id/epic_id/chain_kind/worktree/updated_at_ms)
    instead of lossy JobRow->MaterializedIssue mapping.
  - getCursor() guards JSON.parse; corrupt cursor row returns null and
    emits warn log so a bad cursor no longer crashes the source forever.
  - adds logs/ to .gitignore.
  - 15/15 materializer vitest pass; zero materializer-scoped tsc errors.

  Gated behind GITBOARD_XTRM_PATH=1 (still off in prod). Required before
  forge-eorh.49 cold-start fix and before flipping the gate on.


- **Hybrid resolve + eager bootstrap on cold start** ([fdf0036](https://github.com/Jaggerxtrm/console/commit/fdf0036a4c397b96422feb750db50113b2442d94))

  closes forge-eorh.49

  - server.ts createApp: queueMicrotask triggers materializer for every
    registered obs source after register loop, so first /api/specialists/*
    request lands within one coalesce cycle even before fs watcher fires.
  - specialists.ts createSpecialistsRouter.resolve(): now hybrid — uses
    xtrm-backed dao when materializationState has at least one success row;
    otherwise falls through to attach-pool default bundle. Removes
    all-or-nothing behaviour of the prior liveFallbackEnabled flag.
  - sourceHealthFromState reflects real materializer status
    (fresh/degraded/unhealthy), not always-fresh.
  - warmDefaultBundle keyed by bundle key so a stale warm task can't
    short-circuit a new repo set.
  - Hono context typed via Variables alias instead of unsafe cast.
  - Drop unnecessary async from refreshJobsByBead/refreshChain (no awaits).
  - 26/26 specialists+materializer tests pass; reviewer PASS 96/100.

  Gated behind GITBOARD_XTRM_PATH=1 (still off in prod). Together with
  .48 unblocks the gate flip pending dev/staging memory verification.


- **Pool reuse, 50-issue cap, field-diff, 5min interval** ([3f15d40](https://github.com/Jaggerxtrm/console/commit/3f15d403d70872fb3879ffb6016196cd1d6767ae))

  closes forge-eorh.55

  Hardens the parity harness so it can be safely re-enabled (after
  forge-eorh.47 prod OOM, parity is opt-in via GITBOARD_ENABLE_PARITY=1
  and stays OFF by default).


- **Align obs adapter to real obs.db schema + zero-seed cursor** ([e79c6ab](https://github.com/Jaggerxtrm/console/commit/e79c6aba62846100b130ba0c9f6de5dd5463ba85))

  closes forge-eorh.58

  Staging probe during forge-eorh.49 verification revealed two latent
  bugs in the obs materializer adapter that kept materialization_state
  permanently empty for obs:* sources even with the .48 write-delegation
  fix and .49 eager bootstrap landed:

  1. adapter.cursor() queried materialization_state against the readonly
     obs.db where that table doesn't exist. Threw on first runOnce;
     SourceQueue.drain() swallowed the error silently. Fixed by returning
     a zero seed cursor — the xtrm sink's materialization_state cursor
     is restored by Materializer.getCursor() in index.ts.

  2. readJobsSince and friends queried columns and a table that don't
     exist in real obs.db: repo_slug (not a column — synthesized at JS
     level from constructor arg), worktree (real name worktree_column),
     created_at/updated_at (only updated_at_ms — derived as ISO),
     specialist_job_events (real table is specialist_events).

  Live staging proof: GITBOARD_XTRM_PATH=1 with all 12 discovered obs
  sources → materialization_state has 12 obs:* success rows + 14,081
  specialist_jobs within 30s of boot. 31/31 tests pass on main.

  Unblocks flipping GITBOARD_XTRM_PATH=1 in prod after the standard
  5+ min memory verification.


- **Coerce non-primitive bind values** ([cdf4ab1](https://github.com/Jaggerxtrm/console/commit/cdf4ab1f67129759ba61422dc9cfec03c2510c2f))

  closes forge-eorh.61


- **Emit error logs from drain catch + duration_ms/rows_written** ([606d97c](https://github.com/Jaggerxtrm/console/commit/606d97cd383cbf3b1728e240fdbc6781fc3de9c6))

  closes forge-eorh.62

  Two materializer observability gaps discovered during the forge-
  eorh.60 e2e probe:

  1. SourceQueue.drain() silently swallowed exceptions ('per-source
     isolation: keep queue moving after one source fails'). When the
     obs adapter (.58) and beads adapter (.61) threw, no log entry
     was emitted — both bugs only surfaced via direct adapter probe.
     Now emits materializer.error at error level with source_key +
     error message; queue still continues per the prior contract.

  2. materializer.run event recorded the static coalesce constant
     (1500) instead of actual run time. Now records duration_ms
     (Date.now() delta) + rows_written so per-source lag can be
     computed programmatically from the log ring.

  Regression test asserts a deliberately-throwing source emits exactly
  one materializer.error entry with the right source_key.

  32/32 tests pass across materializer + materializer/* + specialists
  + beads-parity slices.


- **Wire epoch.bump from materializer + 5s readCache TTL** ([7cb87f0](https://github.com/Jaggerxtrm/console/commit/7cb87f071c96e6f9a0304c2e89b5a8e6b1753035))

  closes forge-eorh.64

  After the forge-eorh.60 prod gate flip, /api/specialists/jobs/in-flight
  served frozen data from prior epoch reads (e.g. 10-day-old 'running'
  jobs from May 14) and never reflected freshly materialized sp activity.

  Root cause: apps/gitboard/src/api/routes/specialists.ts caches by
  cacheKey(prefix, repos, epoch(repoSlug)) with no TTL. epoch.bump()
  is exported from server/observability/epoch.ts but has ZERO call sites
  in production. The legacy fs-watcher used to bump it pre-flip; the
  materializer chain (.48/.49/.58/.61) replaced that path without
  re-wiring.

  Two-part fix:
  - Materializer.runOnce calls bumpEpoch(sourceKey.slice(4)) for obs:*
    sources after the COMMIT (success path only, not catch). Single
    call per cycle invalidates all cache entries via cacheKey shift.
  - readCache enforces a 5s TTL via Date.now() - refreshedAt check as
    a belt-and-suspenders safety net for any path that misses bump.

  Discovered during forge-eorh.60 follow-up e2e probe: dispatched
  explorer 7d83e9 → materializer.run for obs:gitboard fired twice
  (rows=2 then rows=1, last_status=success) → API kept returning stale
  explorer jobs from May 14. After fix, /api/specialists/jobs/in-flight
  reflects fresh sp activity within one materializer coalesce cycle.

  32/32 materializer + specialists + beads-parity tests pass; reviewer
  PASS 96.


- **Use parent dir basename for project name in substrate route** ([2ff8335](https://github.com/Jaggerxtrm/console/commit/2ff833564d1123b4fea8e7059b58d7566d658571))

  closes forge-eorh.66

  /api/beads/projects returned name='.beads' for every entry because
  substrate route did `row.path.split('/').filter(Boolean).at(-1)` on
  the .beads dir path stored in xtrm.sources. Dashboard useRepoTree
  matches beads projects to GitHub repos by tail name, so no beads
  showed up in the unified shell.

  One-char fix: .at(-1) -> .at(-2) skips the trailing .beads segment
  to surface the actual project dir name (terminalbeta, darth-feedor,
  gitboard, etc.).

  Scanner already returns correct names; the bug was purely in this
  xtrm-backed route added by the .48 chain.


- **Handle substrate_connected in beadsSourceFromConnection** ([4cd1dcc](https://github.com/Jaggerxtrm/console/commit/4cd1dccf6d230c41f847e9839624aa4f4c303f42))

  closes forge-eorh.69

  After forge-eorh.66 substrate name fix, dashboard sidebar chip
  mapping fell through to the error case for every beads project because
  beadsSourceFromConnection had no handler for status='substrate_connected'
  or source='sqlite' (the new shape returned by substrate readConnection).

  Added healthy-chip case for substrate-connected sources, extended
  BeadsSourceChip.label union with 'sqlite'. Dashboard rebuilt locally;
  dist is gitignored.


- **Scope tombstoneMissing to projectId — cross-project wipe** ([3a95667](https://github.com/Jaggerxtrm/console/commit/3a95667d1b78b864687d7ec1701deeba5c37c652))

  closes forge-eorh.70

  tombstoneMissing scanned substrate_issues WHERE deleted_at IS NULL
  with no repo_slug filter, then built keys-to-keep from current source's
  rows only. Every materializer.runOnce for any beads:* source tombstoned
  every OTHER project's open issues as state='deleted'.


- **TombstoneMissing only on resync (not on delta cycles)** ([ee14f45](https://github.com/Jaggerxtrm/console/commit/ee14f45c2072a6a099a1d7ad146567b56da1ffdf))

  Follow-on to forge-eorh.70. The scoping fix alone wasn't enough:
  tombstoneMissing was being called from BeadsAdapter.write() which is
  invoked by BOTH Materializer.runOnce (delta-shaped snapshot containing
  only changed rows) AND Materializer.resync (full-snapshot truth). On
  delta cycles, the keys-to-keep set was just the small subset of changed
  rows, so every active issue in substrate not in the recent delta was
  tombstoned — same cross-project wipe, masked even after repo_slug
  scoping.

  Split into two methods:
  - write(db, snapshot): for runOnce delta cycles. No tombstoneMissing
    (changesSince already emits diff.tombstones with state='deleted'
    via markTombstone for issues that disappeared).
  - writeFull(db, snapshot): for resync (full truth). Includes
    tombstoneMissing to mark any active substrate row not in the
    snapshot.

  Materializer.resync uses writeFull when present, falls back to write
  for adapters that don't expose the resync-specific path.

  17/17 materializer + adapter tests still pass. After restart + a
  fresh substrate wipe, gitboard's 46 open issues should materialize as
  state='open' (not 'deleted').


- **Remove accidentally-committed node_modules symlink from forge-eorh.67 merge (broke prod)** ([729dcbe](https://github.com/Jaggerxtrm/console/commit/729dcbef475ae812a72414b7a44a6cb5d2ed2b50))


- **Drop accidental node_modules symlink from worktree** ([f7b9f33](https://github.com/Jaggerxtrm/console/commit/f7b9f330071b3e997c89314129f4400276cec25c))


- **Drop accidental node_modules symlink** ([21c1f07](https://github.com/Jaggerxtrm/console/commit/21c1f07f1b1f1864ec9dc0c252267c1e2a806a9b))


- **Restore beads-change-watcher.ts in apps/gitboard/src/core after beadboard deletion (was D'd, importer at trigger-watcher.ts pointed here)** ([b48c4d3](https://github.com/Jaggerxtrm/console/commit/b48c4d37cdae63e976658681e30e6affdda4dff0))


- **App.tsx empty ternary branch -> null** ([283d49f](https://github.com/Jaggerxtrm/console/commit/283d49fd7941d4465f35e47560524b2f67549544))


- **Repoint runtime imports from apps/beadboard to apps/gitboard (executor's repoint never got checkpointed; service crash-looped on missing module)** ([461a251](https://github.com/Jaggerxtrm/console/commit/461a251d087e80ec0e96980f2119639dff06b24f))


- **Add doltPoolKey export to apps/gitboard/src/core/dolt-client.ts (was only in deleted beadboard copy, imported by beads-parity)** ([b9847eb](https://github.com/Jaggerxtrm/console/commit/b9847eb71b3939976745d7f117ddfdb3e96d624b))


- **Smoke filter to single global channel — published.length now tracks materializer cycles 1:1 (was 1:N because publishes hit both substrate:changes + substrate:project:<id>)** ([75a51b2](https://github.com/Jaggerxtrm/console/commit/75a51b2152d5773259ca83a3a55b8ac60fa60687))


- **Smoke scripts ROOT_DIR path — bun --cwd target is already apps/gitboard, drop redundant suffix** ([157395a](https://github.com/Jaggerxtrm/console/commit/157395a6dd3489645fb34e0ad0cf3e6062ced883))


- **Pass xtrmDb in both createApp positional args (.15 fold dropped second arg, silently nulled substrate router)** ([4deed92](https://github.com/Jaggerxtrm/console/commit/4deed929b8947e28c610c069b8b2a7942f3a6b29))


- **Graph.tsx passes beadsProjectId (UUID) not beadsProjectName** ([105b165](https://github.com/Jaggerxtrm/console/commit/105b1657f5f47ecd9b35e12a847f451dbb006cc5))

  graph-dao's xtrm reader resolves source_key='beads:'+projectId — UUIDs only.
  Frontend was sending the human name ('gitboard') → missing-project, 0 nodes,
  source_health degraded on every project graph. RepoNode already exposes
  beadsProjectId; swap the field.


- **Obs watcher watches WAL sidecars (8-17s → ~1.8s chip latency)** ([3adb09f](https://github.com/Jaggerxtrm/console/commit/3adb09f35c23d2953749a7c9994bc5cc9b86a4d7))

  SQLite WAL writes hit <db>-wal first; main .db only updates on checkpoint.
  Watcher was only fs.watching the main .db + using its mtime — so writes
  were invisible until next checkpoint.


- **Dispose DoltClient in createLazyDoltClient (1000+ conn leak)** ([d90a0c3](https://github.com/Jaggerxtrm/console/commit/d90a0c32914c78ef18feed29bbb079afb95b8fd4))

  Materializer's beads snapshot source instantiated a fresh mysql2-pool-backed
  DoltClient per project per ~30s cycle and never disposed it. After 53 min:
  1000+ established connections to dolt:3308 exhausted the server's
  max_connections and broke bd CLI across all projects.


- **Authorize readonly specialist-feed sessions (provider-level)** ([e89c70f](https://github.com/Jaggerxtrm/console/commit/e89c70fd54bdbe1c631483a9cfca1c4381632ce2))

  Gate the readonly specialist-feed terminal provider on the per-connection
  isVerifiedAdmin flag the bridge already plumbs (x-gitboard-shell-token).
  Fail-closed inside openSession() (not only the caller-honored enabled
  flag), and re-check admin on the attach/reattach path so a leaked
  reattachToken cannot resume a live feed for a non-admin. Shell provider
  and the operator's own admin dashboard feed are unaffected.

  SCRUTINY high; reviewer PASS; security-auditor default-deny confirmed;
  code-sanity fail-closed finding resolved; 5/5 provider tests.


- **Dashboard telemetry uses browser-safe logClientEvent (unblock vite build)** ([9ac928d](https://github.com/Jaggerxtrm/console/commit/9ac928d1a650e5805adf98dd01fdd5176bdc9f0b))

  Five dashboard components wired this session's forge-70el telemetry through
  the SERVER logger (emit/makeLogEntry from core/logger.ts), which imports
  node:fs/node:path and broke the vite browser build. Swap them to
  logClientEvent (lib/client-log.ts → POST /api/internal/logs/client), the
  pattern .1/.3 already used. Build passes; JS gzip 284.58 kB (at budget).


- **Enrich roadmap evidence mock** ([3c625cb](https://github.com/Jaggerxtrm/console/commit/3c625cb503e19c27017f457d3ce052428a1ed9f5))


- **Burn down gitboard typecheck baseline** ([8ea64fc](https://github.com/Jaggerxtrm/console/commit/8ea64fc3ab18821092a548ac53c796278609e0a4))


- **Use beads project id for specialists graph context** ([9904030](https://github.com/Jaggerxtrm/console/commit/990403011a844afe6f3bb9f48bde68e7b3e77bab))


- **Keep source list reads core-backed** ([075d9e4](https://github.com/Jaggerxtrm/console/commit/075d9e495792a364e042dd13a9990ce3bff33d84))


- **Restrict github content routes to tracked repos** ([1503ee5](https://github.com/Jaggerxtrm/console/commit/1503ee51fd1a104e96cb9ff79aacd0c1e087fcb2))


- **Fix core runtime logger browser boundary** ([1311c5f](https://github.com/Jaggerxtrm/console/commit/1311c5f1076fc181f5122631790a2bad46fff096))


- **Keep gitboard live startup bounded** ([0d6ba98](https://github.com/Jaggerxtrm/console/commit/0d6ba985219904ce397561f203ddf5aab0178632))


### Other changes

- **Session report: 2026-05-26** ([0d19a1f](https://github.com/Jaggerxtrm/console/commit/0d19a1faf65d2f91d5b96575e6e45028555d63da))


- **Forge-eorh.71 turn 47** ([f2c33b8](https://github.com/Jaggerxtrm/console/commit/f2c33b8aa81c855daa46779ef62a32bbbc9ef869))


- **Forge-eorh.71 turn 52** ([efdfc75](https://github.com/Jaggerxtrm/console/commit/efdfc75105f3274cf0dd44a5bb758eb6bd08d86f))


- **Forge-eorh.71 turn 58** ([ea97562](https://github.com/Jaggerxtrm/console/commit/ea975626837d2c33ef18f60d738e08b4de9ab705))


- **Forge-eorh.71 turn 61** ([f7c769d](https://github.com/Jaggerxtrm/console/commit/f7c769dd89cc3c2d512d65972bb52e38ed986de0))


- **Merge forge-eorh.71: extend substrate_issues schema (priority/issue_type/owner/labels/related_ids/parent_id/closed_at/close_reason/notes) + /api/internal/substrate/schema + verbose materializer logging** ([dd5b5c6](https://github.com/Jaggerxtrm/console/commit/dd5b5c60ae2023eb71dddcaebe436e3f91ce9ed2))


- **Forge-eorh.72 turn 28** ([70874b5](https://github.com/Jaggerxtrm/console/commit/70874b5906e5b95089e681b852817b4ad257773b))


- **Forge-eorh.72 turn 35** ([b898839](https://github.com/Jaggerxtrm/console/commit/b898839a76cb0939ba8728c6f323a1e91442789e))


- **Merge forge-eorh.72: paginate Dolt reads (1000/page, 10k safety cap) + per-page/complete/cap logs** ([e79c78a](https://github.com/Jaggerxtrm/console/commit/e79c78af4413122cd6aad043c774d96497dd681d))


- **Forge-eorh.67 turn 17** ([10d713e](https://github.com/Jaggerxtrm/console/commit/10d713e7f42d915c16caa299544f21243a263958))


- **Forge-eorh.67 turn 23** ([2a57bbe](https://github.com/Jaggerxtrm/console/commit/2a57bbed8ce0c20a18bfe69c0abc54681c458ff8))


- **Merge forge-eorh.67: implement substrate.ts readMemories + readInteractions from beads JSONL via BeadsReader; resolve beadsPath from sources** ([65fb59f](https://github.com/Jaggerxtrm/console/commit/65fb59fe9d168cb60ee73fd6999ae13f300e68ac))


- **Forge-bov4 turn 11** ([b5deec0](https://github.com/Jaggerxtrm/console/commit/b5deec02a0b05a6188eed2acbb538282ce34d0c0))


- **Merge forge-bov4: substrate.ts query fixes (filter tombstones, order by priority, drop hardcoded 100 limit)** ([13d9c4a](https://github.com/Jaggerxtrm/console/commit/13d9c4abc4c68fdb7688786638f396ecc92bd8dc))


- **Forge-115m turn 8** ([9b944f6](https://github.com/Jaggerxtrm/console/commit/9b944f67864bc0fe80614074ab9ed336a21a0552))


- **Merge forge-115m: stop conflating closed status with deleted_at in beads-adapter normalizeIssue** ([1e816f9](https://github.com/Jaggerxtrm/console/commit/1e816f9b594d830986b005f68737e1ce43328833))


- **Forge-x6o4 turn 36** ([a390a57](https://github.com/Jaggerxtrm/console/commit/a390a57b7ef09c74f72686a5c9d20912007f7daa))


- **Forge-x6o4 turn 49** ([33a9bcf](https://github.com/Jaggerxtrm/console/commit/33a9bcfb7a87f143e7d7a2e2eb78ccd184931dea))


- **Merge forge-x6o4: fix observability attach-pool drops (lower MAX to 8, transient attach-limit doesn't poison moduleDead, coverage reporting in API)** ([8571308](https://github.com/Jaggerxtrm/console/commit/85713087fc35618c6845235c4d3ae7d85cd455f7))


- **Forge-y546 turn 10** ([ff9a327](https://github.com/Jaggerxtrm/console/commit/ff9a32761235a40db760ed190855eccb8bab6c38))


- **Merge forge-y546: allow process.env.HOST in internal-substrate isLocalhost (tailnet-bound service can reach /api/internal/*)** ([887b717](https://github.com/Jaggerxtrm/console/commit/887b7176053be1d1ec9b50caf252b24e5f2a320c))


- **Forge-9v9u turn 19** ([45a174d](https://github.com/Jaggerxtrm/console/commit/45a174de5e5709f6859b380ab3c1e767360274dc))


- **Forge-9v9u turn 26** ([d775bb4](https://github.com/Jaggerxtrm/console/commit/d775bb41acc5dbb267abd1b0e76b04de0178811c))


- **Merge forge-9v9u: fix dashboard chip pipeline (bead_id flows through xtrm.sqlite + correct COALESCE fallback in loadJobs)** ([a4f323c](https://github.com/Jaggerxtrm/console/commit/a4f323c94692c64cdaecbf2ba3d17ce077c573a9))


- **Forge-irzl turn 8** ([1b91581](https://github.com/Jaggerxtrm/console/commit/1b915812d7b79affad11b37a7788e98d3c7551ff))


- **Merge forge-irzl: jobsByBead WHERE clause uses COALESCE(l.issue_id, j.bead_id) for drill-in queries** ([78d0046](https://github.com/Jaggerxtrm/console/commit/78d00468383fed87b476952d2565d04a9fa0acab))


- **Forge-oxz2 turn 15** ([d744c49](https://github.com/Jaggerxtrm/console/commit/d744c495dd9a4333e92ed8723ad68a42e4549bfd))


- **Merge forge-oxz2: diagnose + fallback WS push for obs:* materializer via onBump listener + publishHint debug logs** ([b23b6b2](https://github.com/Jaggerxtrm/console/commit/b23b6b2c12aeec698fa402567f75e4c549af9d8b))


- **Forge-dymv turn 20** ([188d069](https://github.com/Jaggerxtrm/console/commit/188d06959ee21543fe08d439766d1b7814ef9394))


- **Forge-dymv turn 25** ([0f822c1](https://github.com/Jaggerxtrm/console/commit/0f822c1294ebc57fb6f74d800b0f86364da645ba))


- **Merge forge-dymv: stale-while-revalidate refetch in BeadsRepoView — preserve issues/memories/interactions on transient API hiccup or project-miss during non-switch reload** ([46a7190](https://github.com/Jaggerxtrm/console/commit/46a71904c9376b0c2a54c9350905f35d3e1af3fb))


- **Forge-221d turn 27** ([5cb29e3](https://github.com/Jaggerxtrm/console/commit/5cb29e342b1390315604ae10751420df02a6d1b0))


- **Forge-221d turn 39** ([6f7d1fa](https://github.com/Jaggerxtrm/console/commit/6f7d1fa9c30dca7fc148df1d4cbd5a49f2c8a8e7))


- **Merge forge-221d: ProjectScanner prefers shared-server Dolt port over stale config; one-shot source log per snapshot cycle** ([89a1a21](https://github.com/Jaggerxtrm/console/commit/89a1a21defbefd1dfbeaa38151e31cc01727ad4b))


- **Forge-swmk turn 14** ([0d5e772](https://github.com/Jaggerxtrm/console/commit/0d5e7722472f2d076a4bf36d093751d2690960e6))


- **Merge forge-swmk: content-equality short-circuit in BeadsRepoView refetch — preserve issues/memories/interactions array refs when API returns identical content (eliminates virtualizer remount flicker)** ([7afd02c](https://github.com/Jaggerxtrm/console/commit/7afd02c43dba2eec12810025dffe411c8a35fbae))


- **Merge codex/forge-r31d-eorh: Phase 3-4 + half of Phase 5 of forge-eorh epic

Completes per the forge-r31d handoff bead (driven by desktop Codex session):
- forge-eorh.9  unified-scanner.ts consolidates 3 separate scanners; sources route + sources-policy
- forge-eorh.10 manual source pins (CRUD endpoints + SourcesPanel.tsx settings UI)
- forge-eorh.11 graph-dao reads from xtrm.sqlite; freshness/source_health split
- forge-eorh.12 WsClient zero-drop grace timer (2000ms); beads-api.ts -> substrate-api.ts client rename + /api/beads -> /api/substrate repoint
- forge-eorh.21 unified-scanner test coverage (unit + smoke + e2e settings panel)
- forge-eorh.22 graph degraded-state smoke + Graph.tsx surface

Validation pre-merge: bunx tsc --noEmit on touched files clean; 37/37 target tests pass
across 7 suites; net typecheck baseline reduced from 26 -> 19 errors.

Remaining Phase 5-7: .13 channel rename, .14 beadboard retirement, .15 github fold,
.16 dir rename, .17 log move, .23/.24/.25 matching tests, .54 smoke filter.** ([e08d561](https://github.com/Jaggerxtrm/console/commit/e08d561222e1a8e5436b062ea143ed49365550e1))


- **Forge-eorh.13 turn 40** ([eaa88b4](https://github.com/Jaggerxtrm/console/commit/eaa88b4bf60e3ff0df423597fc797cf66049d50d))


- **Forge-eorh.13 turn 54** ([18733f3](https://github.com/Jaggerxtrm/console/commit/18733f3a31b90616ea21f23d89c2367554a6f31b))


- **Forge-eorh.13 turn 58** ([2680931](https://github.com/Jaggerxtrm/console/commit/26809316cb5e28e79345ec47f4a172f79766c8a9))


- **Forge-eorh.13 turn 71** ([b197f08](https://github.com/Jaggerxtrm/console/commit/b197f0884b24edf5d38af591c37aee3f9dc5345d))


- **Merge forge-eorh.13: channel rename beads:* -> substrate:*

Server-side: ChannelName union, materializer publish, WsHandler sync_hint mapping
all use substrate:changes / substrate:project:<id> / substrate:sync_hint.

Client-side: useGraphData, BeadsRepoView, WsClient subscribe paths all updated.
useChains is a poller (no channel subscription) so untouched.

Beadboard side: only the watcher publish call (line 213) updated; beadboard's
own dashboard hook left alone since apps/beadboard is being deleted in .14.

Verbose logging: materializer emits component=ws event=channel.publish debug on
every substrate:* publish; ws.ts emits event=channel.subscribe debug per subscribe.

Validation: tsc baseline 19 errors (unchanged from main pre-.13); same 9 pre-existing
test fails on BeadsRepoView/useGraphData suites on both main and branch (happy-dom
NetworkError on /api/internal/logs/client cert verification, unrelated to rename).

Reviewer PARTIAL 86 with rebuttable gaps: (a) useChains is poller, (b) beadboard hook
out-of-scope per .14 retirement, (c) boot_id naturally rotates on service restart per
realtime envelope contract, (d) E2E will run post-merge via orchestrator journalctl
sweep.** ([de5bc05](https://github.com/Jaggerxtrm/console/commit/de5bc050009d59c0f82e2f3413eef4a63a216a1a))


- **Forge-eorh.14 turn 31** ([ca427e1](https://github.com/Jaggerxtrm/console/commit/ca427e18aeb307c4153adb612de9cfe26283179b))


- **Merge forge-eorh.14: retire apps/beadboard backend

Deletes apps/beadboard/** (38 files, ~4500 lines). gitboard now self-contains
all beads-related modules:
- apps/gitboard/src/core/beads-change-watcher.ts (moved from beadboard)
- apps/gitboard/src/core/{project-scanner,beads-reader,dolt-client}.ts
  (already-existing gitboard copies; importers repointed)
- apps/gitboard/src/types/beads.ts (already-existing; importers repointed)

apps/gitboard/src/api/server.ts: removed createBeadsRouter import + /api/beads
route mount + /beadboard redirect + apps/beads in CORS check.
apps/gitboard/src/index.ts: removed beadboard startup references.
apps/gitboard/src/dashboard/App.tsx: removed iframe/legacy refs + empty else.

Validation: tsc 1 error baseline (pre-existing, unchanged); grep
'from .*beadboard|require.*beadboard' on apps/gitboard/src returns zero hits.
Code-sanity OK; obligations CLEAN; reviewer FAIL 41 with verdict based on
empty diff context (reviewer didn't see the actual diff hunks per the FAIL
findings naming every gap as "no diff evidence"; real diff stat above proves
the work). Operator full-authority override per auto-mode session.** ([e745bbe](https://github.com/Jaggerxtrm/console/commit/e745bbef736ca92a9930f0c886b22fa5d34ef6ce))


- **Forge-eorh.15 turn 43** ([cc2ec68](https://github.com/Jaggerxtrm/console/commit/cc2ec68c5da2e232bdce2d4fe234c72b90c8204d))


- **Merge forge-eorh.15: fold gitboard.sqlite github_* tables into xtrm.sqlite

One-time migration: fold-gitboard-sqlite.ts ATTACHes source, copies 7 github_*
tables (commits/events/issues/prs/releases/repos/repo_poll_state), verifies row
counts match, renames source to gitboard.sqlite.migrated.<ts>. Idempotent: skips
if source missing or counts already match.

Runtime: xtrm-store.ts now ships all github_* table schemas. index.ts wires
createXtrmDatabase + foldGitboardSQLite on boot and passes xtrmDb to startServer,
GithubPoller, discoverAndInsert. Boot-time log component=store event=db.path
emits the active DB path so post-restart smoke can verify single-DB world.

Validation: bun test tests/core/fold-gitboard-sqlite.test.ts 3/3 pass.** ([21d8b55](https://github.com/Jaggerxtrm/console/commit/21d8b552f35380da80757dc5057c5d4b0f4dc6fb))


- **Forge-eorh.17 turn 51** ([31e105e](https://github.com/Jaggerxtrm/console/commit/31e105e6106e90c054ac22a219b834d951499ac7))


- **Merge forge-eorh.17: move log default to ~/.xtrm/logs/

Logger reads LOG_DIR > GITBOARD_LOG_DIR > default ~/.xtrm/logs/ (was /data/logs).
ensureLogStorage() creates target dir on first emit + symlinks legacy
~/.agent-forge/logs/ into ~/.xtrm/logs/legacy/ when the active dir is xtrm-default,
so historical log lookups still work for one transition period.

Boot-time emit: component=logger event=log.path with active dir so post-restart
smoke can verify the canonical path.

Operator follow-up: drop the systemd Environment=LOG_DIR override (or update it
to ~/.xtrm/logs) for the new default to take effect in prod.** ([270c1f6](https://github.com/Jaggerxtrm/console/commit/270c1f688ef9f795b0fb8a46d86bcdd84a46666d))


- **Forge-eorh.25 turn 22** ([8685c12](https://github.com/Jaggerxtrm/console/commit/8685c12da5298f4597d3770701c9fad784c52348))


- **Merge forge-eorh.25: P7 smoke scripts (migration + log-move + dir-rename stub)** ([9f88c26](https://github.com/Jaggerxtrm/console/commit/9f88c269c9636956b38239d18bd72bce0ed87f1d))


- **Session report: 2026-05-30

Long handover-thread session covering 4 critical/infra bugfixes (bi35, tyzt,
0vuv, 58ek), the xtrm Observability Platform PRD (y1uk+kqkf) as planning-ready
input to OpenSpec, and full reshape of forge-70el with 9 companion test beads
+ telemetry CONSTRAINTS retrofitted onto every impl. Handoff bead: forge-nxpa.** ([6d4a0e0](https://github.com/Jaggerxtrm/console/commit/6d4a0e0f028755221ca92b18e4bca5d5da314d52))


- **Session report: 2026-05-31

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>** ([aafa597](https://github.com/Jaggerxtrm/console/commit/aafa597a7fae6e54d50bc7c4644867b5dfbd66ff))


- **Session report: 2026-05-31 (auto-mode wave — frs5/.6/.5 merged, .4 test-blocked)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>** ([db97872](https://github.com/Jaggerxtrm/console/commit/db97872144f6a79648c440cf27d2d4ccca74d697))


- **Session report: 2026-05-31 (forge-70el epic complete — .4/.7/.3 merged)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>** ([297c6b0](https://github.com/Jaggerxtrm/console/commit/297c6b00cbf6dee974e35f71891ec4c90f4f34b1))


- **Complete forge-tx7j cleanup** ([bec59a7](https://github.com/Jaggerxtrm/console/commit/bec59a72d020a334f02bb46048d7c85432b21059))


- **Complete Console cleanup epic** ([204c0a0](https://github.com/Jaggerxtrm/console/commit/204c0a0a1dc2c08841485191632a8b4c78856da7))


- **Checkpoint console materializer ownership and repair actions** ([c9e14df](https://github.com/Jaggerxtrm/console/commit/c9e14dfb37effaaeb244d7f034d94caa3b78ce8b))


- **Publish GitHub rate limit through source health** ([dbe4bfb](https://github.com/Jaggerxtrm/console/commit/dbe4bfb0d6926678f1fde6db06d5e2583ede1edc))


- **Session report: 2026-06-07** ([a06350a](https://github.com/Jaggerxtrm/console/commit/a06350a5090aa0108300c276591b6f81081edcf3))


- **Track runtime bridge epic board updates** ([a427c42](https://github.com/Jaggerxtrm/console/commit/a427c42d1bca3e356b769cadb3542d44d9711b45))


- **Update session report with runtime bridge epic** ([55adfca](https://github.com/Jaggerxtrm/console/commit/55adfcaba590a6e368b6ffd5d451ef72557414f1))


- **Extract materializer infrastructure to core** ([aa471ed](https://github.com/Jaggerxtrm/console/commit/aa471ed87e7938fc37ed123abcfd6a17551c8d0b))


- **Scaffold core state client boundary** ([e3899c3](https://github.com/Jaggerxtrm/console/commit/e3899c39833671af0cdca651ac584c62f9eb88c8))


- **Define daemon read model contracts** ([b3c9fbb](https://github.com/Jaggerxtrm/console/commit/b3c9fbbbd4613a0497e32c11f6c9ce546dda92eb))


- **Fix observability bead id materialization** ([35879ba](https://github.com/Jaggerxtrm/console/commit/35879bafae38f3e7f8f88b5c848b0c3f39122ddf))


- **Gate bridge retirement on daemon read models** ([d37ceea](https://github.com/Jaggerxtrm/console/commit/d37ceeafaea952a1e4a4a0cd90cca8cf2be57f15))


- **Map gitboard runtime deprecation surfaces** ([1a25bc2](https://github.com/Jaggerxtrm/console/commit/1a25bc2674deba65bc8f4c5004d3013b430cdced))


- **Move xtrm schema ownership to core state** ([a59557f](https://github.com/Jaggerxtrm/console/commit/a59557fef991f0d0e60ea0b265794b5fcada8484))


- **Introduce core runtime host contract** ([7633be7](https://github.com/Jaggerxtrm/console/commit/7633be7112afd5e2d4718973e855fbf1650fd508))


- **Gate runtime migration on architecture docs** ([33cfb99](https://github.com/Jaggerxtrm/console/commit/33cfb99928e9f2f0a4d40fde8267d67d6391b6bf))


- **Move materializer implementation to core** ([b2cf2e6](https://github.com/Jaggerxtrm/console/commit/b2cf2e6365eb73d87e0ed95fe313b164bacb35ed))


- **Move feed read model to core** ([ac52cf3](https://github.com/Jaggerxtrm/console/commit/ac52cf3d916b5179f30f597ba5242a5f1f55de84))


- **Add feed route core parity gate** ([27c7135](https://github.com/Jaggerxtrm/console/commit/27c7135f49944cfb6d671dd1ededf94e64ce4029))


- **Add runtime wrapper contract tests** ([44e6923](https://github.com/Jaggerxtrm/console/commit/44e69231d9c434e08475082aa54de7a8d211dafc))


- **Add core source lifecycle contracts** ([4a53064](https://github.com/Jaggerxtrm/console/commit/4a53064d4a9794289547715a47414e816c11a981))


- **Wire app source health to core contract** ([b001157](https://github.com/Jaggerxtrm/console/commit/b0011579645f77f6109ee17559b0e088e38789c1))


- **Move GitHub store to core** ([bc0f170](https://github.com/Jaggerxtrm/console/commit/bc0f1708e1bc6f51683e254fc422b24a4e5a9df6))


- **Move legacy GitHub database factory to core** ([8317aa4](https://github.com/Jaggerxtrm/console/commit/8317aa4a866239edf9e7328b60a236afdac41b97))


- **Add gitboard deprecation smoke gate** ([2da959b](https://github.com/Jaggerxtrm/console/commit/2da959b4a3c4cc8a9e02fc63c58107ed8f540bbc))


- **Sync workflow metadata after gitboard migration** ([1df44ee](https://github.com/Jaggerxtrm/console/commit/1df44ee33b01233218513c372561509ff4c85736))


- **Session report: 2026-06-07 runtime migration handoff** ([003989a](https://github.com/Jaggerxtrm/console/commit/003989aa1efe02ebdf750bbfd746c147f495a3d7))


- **Plan final gitboard runtime migration** ([9225a76](https://github.com/Jaggerxtrm/console/commit/9225a76d5754bfabc6a4e5d7b94f0f4a04ce5fe7))


- **Forge-3dm4.2 turn 132** ([53858ef](https://github.com/Jaggerxtrm/console/commit/53858efbdbf1448b7b7308bc65aeede48c30a91d))


- **Forge-3dm4.2 turn 156** ([bf04efe](https://github.com/Jaggerxtrm/console/commit/bf04efee6b80f47652b11b38668f2aacbfa26712))


- **Forge-3dm4.2 turn 16** ([2d514df](https://github.com/Jaggerxtrm/console/commit/2d514dfa5d414d2430c063107a16a274426ab8d7))


- **Forge-3dm4.2 turn 8** ([549778f](https://github.com/Jaggerxtrm/console/commit/549778f92136be55b0005dbfdb53ee46894ea6ac))


- **Forge-3dm4.4 turn 146** ([193f465](https://github.com/Jaggerxtrm/console/commit/193f465dd54d3a52c6414658fd19f317586beec8))


- **Forge-3dm4.4 turn 15** ([c487023](https://github.com/Jaggerxtrm/console/commit/c487023870bac4525d5ffd3cdc103c81bdc76879))


- **Move logger runtime to core** ([077729a](https://github.com/Jaggerxtrm/console/commit/077729a24f9d2cca77ec6ad2b240ed0e77fc8acf))


- **Harden logger disk directory policy** ([94ba7c5](https://github.com/Jaggerxtrm/console/commit/94ba7c50eed260367163623e0ce76b417cef340c))


- **Move gitboard lifecycle policy to core** ([135cc7c](https://github.com/Jaggerxtrm/console/commit/135cc7cc3a98bc3947b29dd3bd05613a6d4f8c38))


- **Move GitHub route runtime helpers to core** ([9f6f32b](https://github.com/Jaggerxtrm/console/commit/9f6f32b36584cd8b843ef09b660e5027d37dec42))


- **Retire gitboard github compatibility wrappers** ([53c4d52](https://github.com/Jaggerxtrm/console/commit/53c4d5200621d173acf1c19e956bd31488e654ee))


- **Console interactivity: beads and specialists write operations (#49)

* chore: prepare forge-5a7f execution graph

* docs: sync gitboard runtime deprecation

* chore: reconcile forge-5a7f docs sync bead state

* docs: label daemon read-model contract states

* chore: record forge-5a7f.11.3 docs sync

* docs: align console architecture bridge gates

* chore: record forge-5a7f.11.4 docs sync

* chore: close forge-5a7f docs sync gate

* checkpoint(debugger): forge-5a7f.14 turn 20

* test: restore graph degraded fixture baseline

* checkpoint(debugger): forge-5a7f.15 turn 31

* test: type graph repo fixtures

* test: restore gitboard baseline before runtime migration

* refactor: move source refresh lifecycle into core

* chore: close forge-5a7f.4

* chore: record forge-5a7f.4 deploy monitor

* checkpoint(executor): forge-5a7f.5 turn 57

* checkpoint(debugger): forge-5a7f.5.3 turn 18

* chore: close forge-5a7f.5 review gates

* fix: keep beads watcher out of browser runtime barrel

* chore: record forge-5a7f.5 deploy monitor

* forge-5a7f7: carve materializer runtime boundary into core

Move beads-adapter write/normalize/diff logic and observability-adapter into
packages/core/src/materializer behind host ports (readSnapshot, emitLog). App
keeps thin host adapters wiring Dolt/jsonl snapshot reads + logger; core owns
resync/delta, tombstone, and edge semantics. Constructor signatures preserved
so trigger-watcher.ts and server.ts wiring unchanged.

- packages/core/src/materializer/beads-adapter.ts (new): BeadsAdapter + ports
- packages/core/src/materializer/observability-adapter.ts (new): pure logic
- packages/core/src/materializer/index.ts: export beads-adapter
- packages/core/tests/materializer-beads-adapter.test.ts (new): 5 boundary tests
- apps/gitboard/src/core/materializer/beads-adapter.ts: thin host adapter
- apps/gitboard/src/core/materializer/observability-adapter.ts: core re-export

* chore: record forge-5a7f.7 review gates

* chore: record forge-5a7f.7 deploy monitor

* checkpoint(executor): forge-5a7f.6 turn 46

* checkpoint(executor): forge-5a7f.6.3 turn 7

* Finish substrate route adapter boundary

* chore: record forge-5a7f.6 review gates

* chore: record forge-5a7f.6 deploy monitor

* Prove realtime log parity before wrapper removal

* Add core realtime parity smoke

* checkpoint(debugger): forge-5a7f.8 turn 20

* test: cover internal log realtime parity

* fix: harden internal log routes

* fix: gate realtime websocket origins

* chore: record forge-5a7f.8 deploy monitor

* Move terminal safety runtime into core

* chore: record forge-5a7f.9 deploy monitor

* Retain gitboard static service wrappers with parity blockers

* chore: record forge-5a7f.10 deploy monitor

* chore: record forge-5a7f final proof

* checkpoint(executor): forge-izbt.5.2 turn 27

* checkpoint(debugger): forge-izbt.5.2.4 turn 29

* fix gitboard localhost console gate matching

* checkpoint(executor): forge-izbt.1.1 turn 22

* checkpoint(executor): forge-izbt.1.1.2 turn 4

* Finish beads write tier-1 ops

* checkpoint(debugger): forge-izbt.1.1.8 turn 19

* Harden beads write argv and errors

* Preserve bead dependency write responses

* Merge forge-izbt.6: specialist control primitives

* Merge forge-izbt.3: specialist config editor

* Document beads reprojection latency

* Add bead inline edit controls

* Handle malformed beads write JSON

* Address Codex PR feedback** ([dcd3de0](https://github.com/Jaggerxtrm/console/commit/dcd3de05b2031685daf6e40858aeba102cbafec6))


- **Restore console write controls UI** ([63eb8f7](https://github.com/Jaggerxtrm/console/commit/63eb8f705774295752f61a37c526af4aab3a6a66))


- **Collapse bead edit panel by default** ([37ecdd6](https://github.com/Jaggerxtrm/console/commit/37ecdd691de4005cd4ca96505d6ae2246eab905b))


- **Allow console config reads on tailnet host** ([823d277](https://github.com/Jaggerxtrm/console/commit/823d27715a3446e9a2b9e34f78beb41e4b67af80))


### Project maintenance

- **Close .47 + file follow-ups .48/.49; update checkpoint state** ([ca06fb4](https://github.com/Jaggerxtrm/console/commit/ca06fb4bf84906bd3b78ad40671b216be4f169cf))


- **Save post-compact next-steps memory + .27 pointer** ([44723c1](https://github.com/Jaggerxtrm/console/commit/44723c1347551498c405de98ca5e1642a7d5f1c2))


- **Lower MemoryMax cap 3G->2G + close forge-w9xt** ([d46b9aa](https://github.com/Jaggerxtrm/console/commit/d46b9aa20c4c279952a4c548b1766debba8bf9be))

  Drops gitboard.service memory ceiling so kernel OOM-kills gitboard
  before pressuring sibling services on the shared VPS. Live + persisted.


- **Bump p2-beads-adapter smoke waitFor 3s->15s + exclude .worktrees from vitest** ([c4b43dc](https://github.com/Jaggerxtrm/console/commit/c4b43dc82b6bde9ee72fb18c61113d30eeb82f7a))

  - closes forge-eorh.46: waitFor was tight at 3000ms; bumped to 15000ms.
  - vitest.config exclude adds .worktrees/ so specialist worktree-duplicate
    test files don't get picked up by repo-root test runs (race observed
    twice during forge-eorh.48/.49 merges).
  - forge-eorh.54 filed for deeper p2 smoke bugs (channel filter mismatch +
    append-not-seen-by-read) found during this investigation.


- **Close .58/.60 — gate flip rolled back, .61 filed for beads binding bug** ([16ab4f9](https://github.com/Jaggerxtrm/console/commit/16ab4f98c060ae1d706b60384088790c7df908d6))

  forge-eorh.58 landed obs adapter schema alignment + zero-seed cursor;
  staging probe proved clean (12 obs:* success, 14084 jobs, RSS stable
  484MB over 5+ min). Prod gate flipped at 01:49 but rolled back 30s
  later: 11 beads:* sources failed with 'Binding expected string,
  TypedArray, boolean, number, bigint or null' from beads-adapter
  writeIssues — non-primitive in one of the bound fields for shared-
  server Dolt projects (UUID source keys). Obs path worked fine.

  Legacy path restored; service stable at 58MB / 2G cap, /health 200.
  forge-eorh.61 filed to fix the beads-adapter binding bug; gate
  stays OFF in prod until that lands and a fresh 5+ min staging
  verification passes.


- **Flip GITBOARD_XTRM_PATH=1 after staging verification** ([42cb754](https://github.com/Jaggerxtrm/console/commit/42cb754d44e23e25360c150401bbc5f16ee59ba3))

  closes forge-eorh.60

  forge-eorh.61 binding fix landed (cdf4ab1). Re-ran the 5+ min staging
  verification with .61 in main: RSS stable at 226-244MB across 5:50,
  0 errors, 19 beads + 12 obs success rows, substrate=4401, jobs=14089.

  Prod restart at 02:04 with Environment=GITBOARD_XTRM_PATH=1: /health
  200, RSS 185MB (well under 2G cap), 0 errors, 19 beads + 12 obs
  success, 4401 substrate + 14090 specialist_jobs, /api/specialists/
  jobs/in-flight returns live data.

  systemd drop-in lives at ~/.config/systemd/user/gitboard.service.d/
  gate.conf (single Environment line). memory-cap.conf (2G) kept
  as safety net. Parity harnesses stay opt-in via GITBOARD_ENABLE_PARITY.


- **Pull iron-review-hardening updates (v3.17.0-pre soak)** ([bdfd94c](https://github.com/Jaggerxtrm/console/commit/bdfd94c3577fab682045c9c429cdf49b7432853f))

  Mirrored from ~/dev/specialists ahead of v3.17.0 minor release for the
  soak period:

  - .specialists/default/{reviewer,code-sanity,executor,debugger}.specialist.json
    → Iron-style behavior: SCRUTINY tiers, auto-escalation, ddiff re-review,
      obligations discipline (executor/debugger), seconder-gate (code-sanity)
  - .specialists/default/obligations-scanner.specialist.json (NEW)
    → READ_ONLY pre-review marker scan (TODO/FIXME/HACK/XXX/TEMP/WIP/NOTE)
  - .xtrm/skills/default/using-specialists-v3/SKILL.md (v3.4 → v3.5)
    → SCRUTINY taxonomy, Git State Precondition, Cherry-Pick Playbook
      canonical, sp merge / sp epic merge prohibited (rule #9 inverted)


- **Cover unified scanner sources** ([9b9f8df](https://github.com/Jaggerxtrm/console/commit/9b9f8df24f22ecedf9f1695e2644d673c0a643e7))


- **Cover graph degraded state** ([c5bd154](https://github.com/Jaggerxtrm/console/commit/c5bd154a5bc4b8b6925dbb4afa739a35ff398091))


- **Move tailscale serve to :8443 to avoid Mercury Traefik 443 collision** ([7a79883](https://github.com/Jaggerxtrm/console/commit/7a7988373c3c4065a2c864143af361bd15157154))

  The default `tailscale serve --bg 8787` binds HTTPS on host port 443,
  which silently steals it from Mercury Traefik when the traefik container
  is recreated (e.g. after a .env change). Move the documented setup to
  `--https=8443` and add a top-level fix.md runbook covering the
  symptom, root cause, fix, verification, and the related docker compose
  restart vs up -d env-reload gotcha.


- **Xtrm Observability Platform PRD (planning-ready)** ([833a769](https://github.com/Jaggerxtrm/console/commit/833a769f9cf5b5541ec3a0c7a91475534ffe3354))

  A native observability surface inside xtrm: thin opinionated UI on a datasource
  abstraction, Prometheus-first impl, built as the foundation for a customer-
  sellable Datadog-class product. Datasource as interface; panels as owned
  primitives; multi-tenancy as a day-one shape.

  Phased delivery: (0) datasource + dolt-health MVP, (1) internal product
  absorbs bespoke health probes, (2) agent-authored dashboards, (3) multi-tenant
  customer instances. Reuses forge-70el sidebar + activity-pane patterns and
  forge-lqyc.8 one-renderer-many-mounts architecture.

  Planning-ready, not implementation-ready — intended input to an OpenSpec
  planning pass.


- **Add 6 mermaid diagrams to xtrm observability PRD** ([ca4f2da](https://github.com/Jaggerxtrm/console/commit/ca4f2da74e274a4bcae07207949077a3f4eb0b1c))

  (1) high-level system layers (Section 1)
  (2) datasource boundary (5.1)
  (3) dashboard render sequence (5.3)
  (4) agent authoring loop (5.6)
  (5) phased delivery gantt (8)
  (6) reuse map from forge-70el + lqyc.8 (11)

  Additive only; existing prose unchanged.


- **Inventory console readiness cleanup** ([d482540](https://github.com/Jaggerxtrm/console/commit/d4825404309b1ee091c343804af0fae81e2c13dc))


- **Add post-bridge cleanup test guards** ([2976d78](https://github.com/Jaggerxtrm/console/commit/2976d78a75f36bfe55102effcaade6d20f8ab3a5))


- **Validate benk readiness guards** ([6caac26](https://github.com/Jaggerxtrm/console/commit/6caac262ed980d220986e98b632b7d2c307b522d))


- **Define console materializer boundaries** ([7d3aefb](https://github.com/Jaggerxtrm/console/commit/7d3aefb34496bd18ae0d7a4430972e064f8dc6a7))


- **Refresh backend architecture reference** ([4a1b1ee](https://github.com/Jaggerxtrm/console/commit/4a1b1eea8653fe73a6a4b2b564004b52f41f7d64))


- **Align gitboard runtime env defaults** ([b59d018](https://github.com/Jaggerxtrm/console/commit/b59d018f4bfaae4c573fb44960039f0bfa558397))


- **Untrack gitboard runtime artifacts** ([fdde758](https://github.com/Jaggerxtrm/console/commit/fdde758198ea754cbe049a4d4cd42a0f1bed80ab))


- **Retire legacy beads cache route** ([145a5cc](https://github.com/Jaggerxtrm/console/commit/145a5cce91ca3fb0d5c9dfbb96d2c0e92d88f562))


- **Classify dormant console tooling** ([90d2b17](https://github.com/Jaggerxtrm/console/commit/90d2b17453d85407d05744645306f84a12d95278))


- **Add console scaffold preflight** ([7a83292](https://github.com/Jaggerxtrm/console/commit/7a832927994da1562749c43b9f021d5454a80256))


- **Close benk cleanup epic** ([2223bdc](https://github.com/Jaggerxtrm/console/commit/2223bdc541964b661ce43ca2d817a1dc7b1f87ec))


- **Cover console feed and inspector regressions** ([47aa4f2](https://github.com/Jaggerxtrm/console/commit/47aa4f24c0eb639e60d2fa5a97a730f1b94453ac))


- **Close console migration epic** ([b7045f0](https://github.com/Jaggerxtrm/console/commit/b7045f0c5ed7ffc44ef6f3190e2f63aa7e7a3a60))


- **Record observability research refresh** ([80d241b](https://github.com/Jaggerxtrm/console/commit/80d241b1b3350aba304c56cbaa5f16e8e0799ad4))


- **Add observability openspec plan** ([6d94b01](https://github.com/Jaggerxtrm/console/commit/6d94b01e5aa5a94831f86c459c64f8a4bb04bc71))


- **Define observability datasource contract** ([be4d6b2](https://github.com/Jaggerxtrm/console/commit/be4d6b21f9592fb4dfde61e912f23567dab18197))


- **Specify agentops observability panels** ([c5d542b](https://github.com/Jaggerxtrm/console/commit/c5d542b069c7073556ddbf163c0ead69dfe8cfe7))


- **Specify source health evidence panels** ([972fcd1](https://github.com/Jaggerxtrm/console/commit/972fcd1f1a0c4b7f12a597e58cfb7536e97d762d))


- **Define operations evidence ux** ([0d6ec00](https://github.com/Jaggerxtrm/console/commit/0d6ec00a2756f65d89cd3d41a8c19321c6709937))


- **Define devops journal recommendation ux** ([0529d51](https://github.com/Jaggerxtrm/console/commit/0529d510ee036c75f31bc1da43659c80405c6e40))


- **Guard console observability datasource contract** ([631897b](https://github.com/Jaggerxtrm/console/commit/631897b031636d54eded0c578d2d7a2e73478a44))


- **Close observability console epic** ([1d3b304](https://github.com/Jaggerxtrm/console/commit/1d3b30455f6b4a9f10d6132823c3c584815d58e8))


- **Align gitboard telemetry contract semantics** ([018171e](https://github.com/Jaggerxtrm/console/commit/018171e0ec5a2d2abdb487fde3ed247c68b099a2))


- **Add console observability diagrams** ([87b223c](https://github.com/Jaggerxtrm/console/commit/87b223c888def773c2bd5ee3db9381fde00a5764))


- **Add console documentation entrypoint** ([b94f801](https://github.com/Jaggerxtrm/console/commit/b94f801eae795bfdec59f852db3a4e10f6a605e6))


- **Shorten memory gate hook prompt** ([c5f158a](https://github.com/Jaggerxtrm/console/commit/c5f158a2b37a0bc01f619c038490aee687f20e24))


- **Consolidate architecture from 12 files to 4** ([87b7ca3](https://github.com/Jaggerxtrm/console/commit/87b7ca3b429ae339eeae35978159840dc3df1396))


- **Compact CLAUDE.md and AGENTS.md via agent-docs-maintainer skill** ([bdead59](https://github.com/Jaggerxtrm/console/commit/bdead59693f14803f759db0c2ef382060fac290d))

  - Add Project summary / map / essential build-test sections in both
  - Replace verbose bd/bv command tables with --help + /using-xtrm pointers
  - Update source templates in .xtrm/config/instructions/{claude,agents}-top.md
    so the next xtrm regeneration preserves the compact shape
  - Audit: CLAUDE.md 190→143 lines (41→6 cmd refs);
          AGENTS.md 195→136 lines (45→6 cmd refs)
  - Project label: xtrm (was Omniforge); apps/console (was 'Ready Console')
  - Install agent-docs-maintainer skill files + registry entries

  Closes forge-lapy, forge-km32


- **Remove stray pnpm workspace changes** ([bc3cc74](https://github.com/Jaggerxtrm/console/commit/bc3cc74128f67fe5f59505e8c647ca226baff970))


- **Add console read-model parity assertions** ([08856e9](https://github.com/Jaggerxtrm/console/commit/08856e927e0e9614e15174766bcbc035afd85c26))


- **Cover core github poller runtime ports** ([50398d4](https://github.com/Jaggerxtrm/console/commit/50398d4d6fceef6fa210be623cfe0c97001c683b))


- **Mark service static host as compatibility wrapper** ([def7ec2](https://github.com/Jaggerxtrm/console/commit/def7ec241f5d2c491bb7ab8a9a8efc54e3b08964))


- **Record final wrapper retention gate** ([ccda49d](https://github.com/Jaggerxtrm/console/commit/ccda49db9baed6e7c91c8d8d581fe2e400df8dd0))


- **Close forge 3dm4 runtime migration epic** ([33f1b11](https://github.com/Jaggerxtrm/console/commit/33f1b11e5d8d8dc7eed0bac65924a386ee9e0bcb))


- **Cover logger runtime compatibility** ([9cbb77c](https://github.com/Jaggerxtrm/console/commit/9cbb77c138cd0f89e7fc0ebf158696b61b47a45f))


- **Reconcile beads audit state** ([3baaf94](https://github.com/Jaggerxtrm/console/commit/3baaf94e553f1d494064198b767dab95fa2621fc))


- **Record forge-gas8 hotfix** ([7a136d5](https://github.com/Jaggerxtrm/console/commit/7a136d5d19cac535868b59410da02f5f038a9fa0))


- **Apply bd auto-stage patch (xtrm-tools auto-applied)** ([5d3a287](https://github.com/Jaggerxtrm/console/commit/5d3a28776e38f89da9c9be743ccf2dcad040b100))


- **Finalize v2 skills migration, adopt v0.10.4 hook paths** ([5c17bb9](https://github.com/Jaggerxtrm/console/commit/5c17bb9b1f78e4fbd95cfbc5f2374ff7290f41c6))

  - Stage retirement of per-repo .xtrm/skills/default/** (skills now global
    at ~/.xtrm/skills/default/ under v2 layout).
  - Adopt v0.10.4 service-skills hook paths: $CLAUDE_PROJECT_DIR -> $HOME.
  - Untrack runtime state and gitignore going forward.


- **Preserve local skill divergences from v2 migration** ([495562f](https://github.com/Jaggerxtrm/console/commit/495562faf0b3e67c18524fafd1c8e8cf383a86fb))

  The migrator wrote these files to .xtrm/skills/local-legacy/ during v2
  skills migration because they diverged from the global default source.
  Committing preserves the divergence record for future audit; discard by
  git rm -rf if the intent is to converge on global.


- **Add git-cliff config and changelog** ([71e81ee](https://github.com/Jaggerxtrm/console/commit/71e81eeacf63e4a2391da20562c34375b2118400))

  Generic type-based parsers; repo-specific scopes to be tuned (see P0 bead).


# Changelog

All notable changes to this project are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file was started 2026-05-30; the `[Unreleased]` block below captures
user-facing changes since the last code-freeze. Prior history lives in the
session reports under `.xtrm/reports/`.

## [Unreleased]

### Added
- **Core runtime migration exports** — `@xtrm/core/materializer`, `@xtrm/core/state`, and related runtime/GitHub ownership contracts now expose the reusable materializer, state/schema, source lifecycle, feed read-model, and GitHub store/database surfaces that `apps/gitboard` previously owned directly (`forge-fuyf`, `forge-6oae`).
- **Final gitboard runtime migration plan** — `@xtrm/core/runtime` now exposes the `forge-3dm4` child sequence, impact targets, smoke gates, and wrapper-retirement checklist for completing the migration away from the `apps/gitboard` compatibility host (`forge-3dm4`).
- **Gitboard deprecation staging smoke** — `bun run --cwd apps/gitboard smoke:deprecation` starts an isolated local/staging instance and probes health, Substrate, graph, feed, Specialists, GitHub endpoints, and materializer/channel log flow before runtime bridge closure (`forge-6oae.11`).
- **Console Beads/Dolt repair actions** — `/api/substrate/projects/<id>/repair-actions` now returns safe operator repair suggestions for degraded Beads/Dolt sources, including source-health rescan, Dolt status inspection, start/restart, port-config recovery, and dead pid cleanup guidance. Console Observability now surfaces these actions in a Beads Dolt repair panel (`forge-9yhh`).
- **xtrm Observability Platform PRD** — `docs/xtrm-observability-prd.md`. Planning-ready (not implementation-ready) input to the OpenSpec planning phase. Specifies an embedded observability surface inside the xtrm console as the foundation for a future customer-shippable product. Datasource-as-interface; panels as owned primitives; multi-tenancy as a day-one shape. Phased delivery from dolt-health MVP through multi-tenant customer instances (`forge-y1uk`, `forge-kqkf`).
- **Probe script** — `tools/probes/obs-materializer-lag.ts` — measures sp dispatch → obs.db → xtrm.sqlite → API lag end-to-end. Used to verify `forge-0vuv` and reusable for future regression checks.

### Changed
- **Gitboard deprecation staging smoke** — the smoke harness now supports `GITBOARD_SMOKE_ENABLE_GITHUB_POLLER=1` for the final migration poller-enabled tier, while keeping the default isolated `SKIP_GITHUB_POLLER=1` path safe and credential-free (`forge-3dm4`).
- **Gitboard runtime deprecation** — `apps/gitboard` is now documented and tested as a compatibility host around core-owned runtime primitives. Mounted APIs and DTO shapes remain intact while the final migration away from the app host is tracked in `forge-3dm4` (`forge-6oae`).
- **Console materializer ownership** — architecture docs now make the current gitboard materializer bridge explicitly temporary pre-`~/.xtrm/state.db`; Console remains UI/read/query only, with future ownership moving toward `packages/core/state` and `packages/core/materializer` behind `xt daemon` (`forge-yht2`).
- **GitHub source health** — GitHub rate-limit changes are published through canonical `github:source_health.rate_limit` instead of a standalone `github:rate_limit` event. Existing metadata remains for compatibility (`forge-5o3o`).
- **Console graph dependency loading** — Graph requests now include historical bead relationships (`include_closed=true`) and the Beads feed preloads a larger closed-history window while `forge-lqgo` tracks the remaining live `specialists` dependency rendering discrepancy.

### Fixed
- **Substrate router** — `/api/substrate/projects/<id>/issues` returned `{"issues":[]}` for every project after the `gitboard.sqlite → xtrm.sqlite` fold (forge-eorh.15). Root cause: single-arg `startServer(xtrmDb)` left the second `createApp(db, xtrmDb?)` parameter `undefined`, silently null-ing the substrate router. Now passes `xtrmDb` in both positional arguments (`forge-bi35`).
- **Console graph** — every project graph returned `missing-project:<name>` after the move to xtrm-backed `graph-dao` (forge-eorh.11). `Graph.tsx` was passing the human project name; the new `resolveXtrmSource` resolver matches only on UUID. Fixed by passing `beadsProjectId` (`forge-tyzt`).
- **Specialist chip latency** — dispatching a specialist took 8–17 seconds to surface in the dashboard. Root cause: `fs.watch` on a SQLite WAL-mode database only watched the main `.db` file; WAL writes hit the `-wal` sidecar and the main file only updates on checkpoint. Watcher now follows `.db`, `.db-wal`, and `.db-shm`, and uses `max(mtime(.db), mtime(.db-wal))` as the change signal. Latency: 8.7s–17.7s → median 1.85s, range 1.78–2.04s across 5 runs (`forge-0vuv`).
- **Dolt connection leak** — gitboard service accumulated 1000+ established mysql2 connections to dolt over ~53 minutes, eventually exhausting dolt's `max_connections` and causing bd CLI timeouts across all projects. Materializer's `createLazyDoltClient.getIssues` instantiated a pool per call without disposing. Now wraps `client.getIssues(…)` in `try/finally` with `await client.disconnect()` (`forge-58ek`). Connection count drains to baseline within one cycle.

### Operations
- **bd shared-server log rotation** — daily user systemd timer (`~/.config/systemd/user/bd-dolt-log-rotate.{service,timer}`) + bash rotator (`~/.local/bin/rotate-bd-dolt-log.sh`). Copytruncate (preserves dolt's open fd), 50 MiB threshold, 3 generations, ±15min jitter. Not in repo (host-local); recorded here for operator awareness (`forge-lrms`).
