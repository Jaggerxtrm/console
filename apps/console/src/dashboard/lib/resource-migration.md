# Dashboard resource kernel migration guide

Scope for later beads:

- `BeadsRepoView.tsx`
  - move reload / sync-hint handling onto shared resource kernel
  - preserve optional delta application for issue upserts
- `useGithubActivity.ts`
  - replace local sync-hint / loading orchestration with resource adapter
  - keep store updates as selector layer only
- `useSpecialistHistory.ts`
  - convert per-bead cache + pending request map to shared resource cache
- `useInFlightJobs.ts`
  - move poll/focus/visibility logic onto shared resource kernel

Checklist:

- HTTP response stays source of truth.
- WS only invalidates or applies pure delta.
- Cache key stable and explicit.
- Freshness / last-successful-data come from shared kernel.
- Coalesced invalidation uses one refresh burst per key.
- Visibility / focus refresh remains enabled.
- Polling stays fallback only.
- Add one regression test per migrated source.
