## 📦 updating-dependencies — SECURITY_FORCED (remediated)

**ws** `8.19.0` → `8.21.0` (npm, transitive/test via happy-dom)

> Case `forge-wv9i.21-ws` · verdict decided by `updating-dependencies` skill

### Summary
Transitive dev/test-only dependency pulled by `happy-dom@20.8.4` (range `^8.18.3`);
not a runtime dependency of any shipped service. The advisory GHSA-96hv-2xvq-fx4p
(OOM DoS, fixed 8.21.0) ships a working public PoC, which forces **SECURITY_FORCED**
under rigid policy §4.1 — a non-negotiable trigger that is not downgraded by test-only
reachability. The lock is remediated to exactly 8.21.0 via a root `overrides` pin
(not 8.21.1) per cooldown discipline. Production blast radius is bounded (test-only),
but the forced verdict stands and is satisfied by the fix.

### Why this verdict
SECURITY_FORCED (remediated): public_exploit_available=true (advisory PoC) forces the
verdict per policy §4.1 regardless of reachability. Remediated because the target equals
the fixing version 8.21.0 (Tier 1 OSV + registry), API unchanged (Tier 2 patch line).
Test-only reachability bounds production exposure but does not change the forced verdict.

### Security
- Advisories: 1 (SECURITY_FORCED: 1) — GHSA-96hv-2xvq-fx4p / CVE-2026-48779 · CVSS 7.5 · fixed 8.21.0
- Known exploited: no · Public exploit: **yes** (advisory ships a working OOM DoS PoC → forces SECURITY_FORCED) · EPSS: low (0.782%)
- Malicious-package signal: none

### Supply chain
- Release age: 1448.3h · Cooldown: bypassed (SECURITY_FORCED bypasses cooldown; 8.21.0 also clears on age) · Registry: normal

### Evidence
- `bun install --frozen-lockfile` → no changes (lock consistent)
- `osv-scanner scan --lockfile ./bun.lock` → no ws finding (advisory remediated at 8.21.0)
- `tests/api/ws/*` realtime/replay/boundary suites green
- Workspace lint + build green

### Required gate on this PR
SECURITY_FORCED gate is **satisfied**: the forced finding is remediated at the fixing
version (8.21.0) and OSV confirms no ws advisory remains. Had the fix not been applied,
this check would FAIL the PR until remediated.

### Follow-ups
- When happy-dom advances its `ws` range or a newer ws clears cooldown, reassess dropping the `ws` override.

---
<sub>Evidence-first verdict · community signals never block alone · full dossier at docs/dependencies/forge-wv9i.21/ws/ (case forge-wv9i.21-ws)</sub>
