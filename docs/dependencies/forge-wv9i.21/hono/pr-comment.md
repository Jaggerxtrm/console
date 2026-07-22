## 📦 updating-dependencies — PASS_WITH_NOTES

**hono** `4.12.8` → `4.12.27` (npm, direct/runtime)

> Case `forge-wv9i.21-hono` · verdict decided by `updating-dependencies` skill

### Summary
Direct runtime HTTP host dependency of `apps/gitboard` + `packages/html-preview`.
Clears GHSA-88fw-hqm2-52qc (CORS credentials reflection, fixed 4.12.25) at a
cooldown-cleared version. The vulnerable path is unreachable here (bare `cors()`,
`credentials` false). Under-cooldown latest `4.12.31` (75h) deliberately avoided via a
root `overrides` pin. No HTTP/CORS contract change.

### Why this verdict
PASS_WITH_NOTES: advisory cleared at cooldown-cleared 4.12.27 (Tier 1 OSV + registry),
no code change required (Tier 2 patch line), exploit path unreachable. Notes attached
because hono is a production runtime dependency (post-deploy watch advised) and the lock
is override-pinned to stay deterministic.

### Security
- Advisories: 1 (SECURITY_FORCED: 0) — GHSA-88fw-hqm2-52qc / CVE-2026-54290 · CVSS 7.1 · fixed 4.12.25
- Known exploited: no · Public exploit: no · EPSS: low (0.248%)
- Malicious-package signal: none

### Supply chain
- Release age: 695.5h · Cooldown: cleared (4.12.31 = 75h → active → avoided) · Registry: normal

### Evidence
- `bun install --frozen-lockfile` → no changes (lock consistent)
- `osv-scanner scan --lockfile ./bun.lock` → no hono finding (advisory resolved)
- `tests/api/cors-compatibility.test.ts` + `ws/origin-policy` green (same-origin 200, hostile-origin no credentials reflection)
- Workspace lint + build green

### Required gate on this PR
No merge block from this check. Details above. Production `gitboard.service` restart
remains gated until reviewer PASS.

### Follow-ups
- Once hono 4.12.31+ clears cooldown, drop the `hono` override and let `^4.12.27` track upstream.

---
<sub>Evidence-first verdict · community signals never block alone · full dossier at docs/dependencies/forge-wv9i.21/hono/ (case forge-wv9i.21-hono)</sub>
