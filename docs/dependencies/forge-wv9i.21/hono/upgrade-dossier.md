# Upgrade Dossier — hono 4.12.8 → 4.12.27

> Stable-section output of the `updating-dependencies` skill. Fill EVERY section.
> case_id: `forge-wv9i.21-hono` · verdict: **PASS_WITH_NOTES**

## Summary
`hono` is a direct runtime HTTP host dependency of `apps/gitboard` and
`packages/html-preview`. The locked 4.12.8 is affected by GHSA-88fw-hqm2-52qc
(CORS middleware reflects any Origin with credentials when `origin` defaults to the
wildcard; fixed in 4.12.25). Bumping to 4.12.27 clears the advisory at a
cooldown-cleared version while deliberately avoiding the under-cooldown latest
(4.12.31, 75h old). The vulnerable path is not reachable in this repo (bare `cors()`,
`credentials` false), so this is defense-in-depth advisory clearance on a production
runtime dep — verdict PASS_WITH_NOTES with a post-deploy watch.

## Trigger
advisory · repo `Jaggerxtrm/console` · branch `feature/forge-wv9i.21-executor` ·
bead `forge-wv9i.21` (epic `forge-wv9i`). Separate PR from the scheduler/watcher OOM fix.

## Package / version diff
name `hono` · ecosystem npm · 4.12.8 → 4.12.27 · update_kind patch ·
dependency_kind **direct** · scope **runtime**.

## Source matrix
- Tier 1 Authoritative: OSV GHSA-88fw-hqm2-52qc (alias CVE-2026-54290, SEMVER fixed
  4.12.25, CVSS:3.1 AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:L/A:N = 7.1); npm registry release
  timestamps (4.12.27 = 695.5h cleared; 4.12.31 = 75h active); `bun.lock` resolved
  `hono@4.12.27` + integrity hash; `osv-scanner` v2.0.2 lockfile scan (no hono finding).
- Tier 2 Migration semantics: hono 4.12.x patch line — no breaking API changes between
  4.12.8 and 4.12.27; the only behavioral delta is the CORS middleware advisory fix.
- Tier 3 Threat intel: none — no malicious-package or supply-chain signal; hono is a
  high-trust, widely-deployed framework.
- Tier 4 Community (never blocks alone): none required.

## Security context
Advisory GHSA-88fw-hqm2-52qc / CVE-2026-54290 · CVSS 7.1 · EPSS 0.248% (low bucket) ·
known_exploited no · public_exploit no · malicious_package_signal none ·
SECURITY_FORCED **no** (CVSS < 9.0, EPSS low, no CISA KEV, no active exploitation).
Reachability: `apps/gitboard/src/api/server.ts:150` mounts bare `cors()`; `credentials`
defaults to false, so the "reflect Origin + Access-Control-Allow-Credentials: true"
exploit path is unreachable. Service runs on a private tailnet / local host (not
publicly exposed).

## Supply-chain context
release_age_hours 695.5 · cooldown_status **cleared** (≥168h) · registry_status normal ·
maintainer_change_detected false · install_script_changed false · artifact_repo_mismatch
none. Latest 4.12.31 is 75h old → cooldown **active** → deliberately NOT selected; root
`overrides` pin `hono@4.12.27` keeps the lock deterministic at the cleared target.

## Compatibility / migration notes
Patch line, no breaking changes, no deprecated API. The CORS middleware fix does not
alter our bare-`cors()` behavior (verified by `cors-compatibility.test.ts`: same-origin
200, no `Access-Control-Allow-Credentials` reflected to a hostile origin, preflight
clean). No code/config/workflow change required.

## Local usage map
affected_services: `apps/gitboard`, `packages/html-preview`. affected_files:
`apps/gitboard/package.json`, `packages/html-preview/package.json`,
`apps/gitboard/src/api/server.ts`. runtime_reachable **yes** (HTTP host).
publicly_exposed_path **no** (tailnet/local). github_actions_blast_radius **low**.

## Service-skill impact
No `Dependency Surface` section present (`dependency_surface_present: false`).
Health check: `/health`. Proposed post-update watch signals: request_error_rate,
cors_preflight_failure_rate, restart_count (see post-deploy-watch-spec.md).

## Tests
existing relevant: `tests/api/ws/origin-policy.test.ts`,
`tests/api/ws/realtime-contract.test.ts`, `tests/api/routes/sources-policy.test.ts`,
`tests/api/server-runtime-host.test.ts`. added:
`apps/gitboard/tests/api/cors-compatibility.test.ts`. recommended_commands:
`bun install --frozen-lockfile`; `osv-scanner scan --lockfile ./bun.lock`;
`bunx vitest run tests/api/cors-compatibility.test.ts tests/api/ws/origin-policy.test.ts`.

## Verdict
**PASS_WITH_NOTES** — advisory cleared at a cooldown-cleared target (Tier 1), no code
change required (Tier 2), vulnerable path unreachable. Notes: production runtime dep →
post-deploy watch; lock pinned via root override to avoid under-cooldown 4.12.31.

## Required gates
Advisory comment only — no merge block. Frozen-install + OSV evidence attached.
Production `gitboard.service` restart stays gated until reviewer PASS.

## Deploy notes
Scoped remediation PR. After reviewer PASS, deployer restarts `gitboard.service` and
hands the post-deploy watch spec to SRE. Patch-level, no reachable behavior change.

## Post-deploy watch spec
See `post-deploy-watch-spec.md` (emitted: PASS_WITH_NOTES on a production runtime dep).

## Follow-up tasks
- followup (discovered-from forge-wv9i.21): once hono 4.12.31+ clears cooldown, drop the
  `hono` override and let `^4.12.27` track upstream.
- gate: block production `gitboard.service` restart until reviewer PASS.
