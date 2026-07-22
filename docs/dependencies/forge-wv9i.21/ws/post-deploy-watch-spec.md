# Post-Deploy Watch Spec — ws

> Hand-off to SRE for post-deploy regression watch (spec §15). Emitted on
> SECURITY_FORCED-remediated (lock-remediated transitive test dependency; public PoC forced the verdict).

## Scope
- repo: Jaggerxtrm/console
- service: test environments of apps/gitboard and apps/console (happy-dom DOM env)
- environment: CI / local test runs (no production runtime surface)

## Dependency update
- package: ws
- from → to: 8.19.0 → 8.21.0
- case_id: forge-wv9i.21-ws

## Windows
- baseline: 24h before merge
- watch: next 2 scheduled CI test runs (test-only dependency)

## Signals
- metrics: test_suite_duration, happy_dom_env_failures, vitest_worker_restarts
- logs: new error fingerprints in happy-dom-backed suites, WebSocket-related test errors
- traces: n/a (no production runtime path)

## Expected risk area
happy-dom's internal use of `ws` inside the test DOM environment. The bump is a
patch-line, API-unchanged fix; watch only for any regression in happy-dom-backed suites
(realtime/replay contract tests, dashboard `ws.test.ts`). No production service impact
expected — `ws` is not bundled into any shipped runtime.

## Verdicts
PASS · DEGRADED · FAIL · UNKNOWN

## Escalation
- on FAIL → devops-sre
- on UNKNOWN → follow-up: missing telemetry
- rollback recommendation → only when thresholds AND confidence are strong
