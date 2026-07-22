# Upgrade Dossier — ws 8.19.0 → 8.21.0

> Stable-section output of the `updating-dependencies` skill. Fill EVERY section.
> case_id: `forge-wv9i.21-ws` · verdict: **SECURITY_FORCED** (remediated)

## Summary
`ws` is a transitive dependency pulled only by `happy-dom@20.8.4` (range `^8.18.3`),
the dev/test DOM environment used by vitest suites in `apps/gitboard` and
`apps/console`. It is NOT a runtime dependency of any shipped service. The locked
8.19.0 is affected by GHSA-96hv-2xvq-fx4p (memory-exhaustion DoS from tiny fragments;
fixed in 8.21.0). The advisory ships a working public PoC, so under rigid policy §4.1
this finding is **SECURITY_FORCED** — a disjunctive, non-negotiable trigger that does
not admit a reachability-based downgrade. The lock is remediated to exactly 8.21.0 via
a root `overrides` pin (not 8.21.1) per operator cooldown discipline. Because
reachability is test-only, production blast radius is bounded, but the forced verdict
stands; verdict **SECURITY_FORCED (remediated)** with a retained post-deploy watch.

## Trigger
advisory · repo `Jaggerxtrm/console` · branch `feature/forge-wv9i.21-executor` ·
bead `forge-wv9i.21` (epic `forge-wv9i`). Separate PR from the scheduler/watcher OOM fix.

## Package / version diff
name `ws` · ecosystem npm · 8.19.0 → 8.21.0 · update_kind patch ·
dependency_kind **transitive** (via happy-dom) · scope **test**.

## Source matrix
- Tier 1 Authoritative: OSV GHSA-96hv-2xvq-fx4p (alias CVE-2026-48779, 8.x SEMVER fixed
  8.21.0, CVSS:3.1 AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H = 7.5); npm registry release
  timestamps (8.21.0 = 1448.3h cleared; 8.21.1 = 177.1h cleared); `bun.lock` resolved
  `ws@8.21.0` + integrity hash; happy-dom manifest range `^8.18.3` (satisfied);
  `osv-scanner` v2.0.2 lockfile scan (no ws finding).
- Tier 2 Migration semantics: ws 8.x patch line — API unchanged between 8.19.0 and
  8.21.0; the fix is internal fragment/chunk memory-accounting.
- Tier 3 Threat intel: none — no malicious-package or supply-chain signal; ws is the
  canonical, high-trust WebSocket library.
- Tier 4 Community (never blocks alone): none required.

## Security context
Advisory GHSA-96hv-2xvq-fx4p / CVE-2026-48779 · CVSS 7.5 (A:H OOM DoS) · EPSS 0.782%
(low bucket) · known_exploited no · malicious_package_signal none ·
public_exploit_available **true** (advisory ships a working OOM DoS PoC) ·
SECURITY_FORCED **yes**. Rigid policy §4.1 is disjunctive: "public exploit / PoC
available" alone forces SECURITY_FORCED. This trigger is non-negotiable and is NOT
downgraded by test-only reachability — reachability bounds production blast radius but
does not change the forced verdict. The finding is **remediated** because the target
(8.21.0) equals the fixing version. No CISA KEV and no active exploitation reported;
`ws` is not runtime-reachable (test-only via happy-dom).

## Supply-chain context
release_age_hours 1448.3 · cooldown_status **cleared** · registry_status normal ·
maintainer_change_detected false · install_script_changed false · artifact_repo_mismatch
none. 8.21.1 (177.1h, cleared) deliberately NOT selected; root `overrides` pin `ws@8.21.0`
forces the exact advisory-fixing version within happy-dom's `^8.18.3` range without a
broad refresh.

## Compatibility / migration notes
Patch line, API unchanged. `ws` is consumed only transitively by happy-dom inside test
environments — no application source imports `ws` directly. No code/config/workflow
change required.

## Local usage map
affected_services: `apps/gitboard`, `apps/console` (happy-dom test env). affected_files:
`apps/gitboard/package.json`, `apps/console/package.json`, `bun.lock`. runtime_reachable
**no**. publicly_exposed_path **no**. github_actions_blast_radius **low**.

## Service-skill impact
No `Dependency Surface` section present (`dependency_surface_present: false`). No
production health check (test-only). Proposed post-update watch signals:
test_suite_duration, happy_dom_env_failures (see post-deploy-watch-spec.md).

## Tests
existing relevant: `tests/api/ws/realtime-contract.test.ts`,
`tests/api/ws/server-boundary.test.ts`, `tests/dashboard/lib/ws.test.ts` (these exercise
the app's own WS contract, not the `ws` lib directly). missing: none (test-only dep).
recommended_commands: `bun install --frozen-lockfile`;
`osv-scanner scan --lockfile ./bun.lock`; `bunx vitest run tests/api/ws`.

## Verdict
**SECURITY_FORCED (remediated)** — forced by rigid policy §4.1 because
public_exploit_available=true (advisory PoC); the trigger is non-negotiable and is not
downgraded by test-only reachability. Remediated because the target equals the fixing
version 8.21.0 (Tier 1), API unchanged (Tier 2 patch line). Notes: lock pinned via root
override to exactly 8.21.0 (not 8.21.1); production blast radius bounded (test-only
reachability); post-deploy watch retained per SECURITY_FORCED-remediated handling.

## Required gates
The advisory blocks until remediation gates pass. This branch contains the remediation;
frozen-install, OSV, security regression, and reviewer evidence must all pass before merge.

## Deploy notes
No production runtime impact (test-only). No service restart attributable to ws; the
production `gitboard.service` restart is governed by the hono case / reviewer PASS.

## Post-deploy watch spec
See `post-deploy-watch-spec.md` (emitted: SECURITY_FORCED-remediated — verify happy-dom
test env stays green after the lock remediation).

## Follow-up tasks
- followup (discovered-from forge-wv9i.21): when happy-dom advances its `ws` range or a
  newer ws clears cooldown, reassess dropping the `ws` override.
