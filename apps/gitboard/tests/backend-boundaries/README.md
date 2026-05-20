# forge-ojn4 backend performance boundaries

This directory holds the coverage contract for the backend performance hardening epic. The contract test does not replace the behavior tests; it fails if one of the regression suites that guards a known latency/freshness boundary is removed or renamed without a deliberate replacement.

Covered boundaries:

- Beads closed-route ordering.
- Dolt runtime isolation by pool key.
- Graph route cache/invalidation behavior.
- GitHub PR detail/report fan-out bounds.
- GitHub poller concurrency, ETag, backoff, and WS publication behavior.
- Specialist job endpoint epoch-aware caching.
