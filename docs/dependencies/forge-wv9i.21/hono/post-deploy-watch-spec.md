# Post-Deploy Watch Spec — hono

> Hand-off to SRE for post-deploy regression watch (spec §15). Emitted on
> PASS_WITH_NOTES (production runtime dependency security remediation).

## Scope
- repo: Jaggerxtrm/console
- service: apps/gitboard (HTTP host); packages/html-preview (viewer server)
- environment: production tailnet (gitboard.service)

## Dependency update
- package: hono
- from → to: 4.12.8 → 4.12.27
- case_id: forge-wv9i.21-hono

## Windows
- baseline: 24h before deploy
- watch: 24h (patch-level, no reachable behavior change)

## Signals
- metrics: request_error_rate, latency_p95/p99, restart_count, cors_preflight_failure_rate
- logs: exception_rate, new error fingerprints, CORS/origin denials, 4xx/5xx spikes on `/api/*` and `/health`
- traces: span_error_rate, critical-path latency on `/api/feed`, `/api/internal`, WebSocket upgrade paths

## Expected risk area
CORS middleware behavior after the advisory fix. Our config mounts bare `cors()`
(`credentials` false), so no behavior change is expected; watch for any regression in
same-origin API success, preflight handling, or WebSocket origin policy
(`isAllowedRealtimeWebSocketOrigin` / `isAllowedShellWebSocketOrigin`).

## Verdicts
PASS · DEGRADED · FAIL · UNKNOWN

## Escalation
- on FAIL → devops-sre
- on UNKNOWN → follow-up: missing telemetry
- rollback recommendation → only when thresholds AND confidence are strong
