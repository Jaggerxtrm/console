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
- **Gitboard deprecation staging smoke** — `bun run --cwd apps/gitboard smoke:deprecation` starts an isolated local/staging instance and probes health, Substrate, graph, feed, Specialists, GitHub endpoints, and materializer/channel log flow before runtime bridge closure (`forge-6oae.11`).
- **Console Beads/Dolt repair actions** — `/api/substrate/projects/<id>/repair-actions` now returns safe operator repair suggestions for degraded Beads/Dolt sources, including source-health rescan, Dolt status inspection, start/restart, port-config recovery, and dead pid cleanup guidance. Console Observability now surfaces these actions in a Beads Dolt repair panel (`forge-9yhh`).
- **xtrm Observability Platform PRD** — `docs/xtrm-observability-prd.md`. Planning-ready (not implementation-ready) input to the OpenSpec planning phase. Specifies an embedded observability surface inside the xtrm console as the foundation for a future customer-shippable product. Datasource-as-interface; panels as owned primitives; multi-tenancy as a day-one shape. Phased delivery from dolt-health MVP through multi-tenant customer instances (`forge-y1uk`, `forge-kqkf`).
- **Probe script** — `tools/probes/obs-materializer-lag.ts` — measures sp dispatch → obs.db → xtrm.sqlite → API lag end-to-end. Used to verify `forge-0vuv` and reusable for future regression checks.

### Changed
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
