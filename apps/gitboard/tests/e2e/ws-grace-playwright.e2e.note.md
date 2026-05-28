# Deferred e2e: WsClient grace timer + substrate channel roundtrip

`forge-eorh.23` SCOPE listed two Playwright e2e tests (`ws-grace.e2e.ts`,
`substrate-channel-roundtrip.e2e.ts`) requiring CDP-level network panel
inspection. This repo has no Playwright harness installed (see forge-eorh.22
close note — project ships Testing Library + happy-dom only).

Coverage actually shipped for .23:
- **Grace timer unit tests** — `tests/dashboard/lib/ws.test.ts` (3 tests
  covering grace schedule / pre-grace-cancel / post-grace-fire; 15/15 pass).
- **Channel grep smoke** — `tests/smoke/p5-channel-grep.sh` (greps src/ for
  stale "beads:(changes|sync_hint|project)" refs; passes today).
- **Live e2e proof from .13 merge** — post-restart, 88 substrate:* publishes
  and 0 beads:* leaks in ~/.xtrm/logs/2026-05-28.jsonl.

To restore the original .23 plan once Playwright lands, add the harness to
package.json devDeps and implement the two suites against PORT=3030 tailnet
or a launched localhost service.
