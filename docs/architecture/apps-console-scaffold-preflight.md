# apps/console Scaffold Preflight

Status: archived historical scaffold reference.

This document records the constraints used when `apps/console` was first
scaffolded. It is not an operational guide: Console now owns the frontend,
backend, APIs, and runtime lifecycle. Paths and commands below intentionally
describe the retired source baseline.

## Source Baseline

Use `apps/gitboard` as the backend/API/materializer source because it remains
the only running service and already contains the post-bridge boundaries.

Copy/adapt first:

- `apps/gitboard/package.json`
- `apps/gitboard/tsconfig.json`
- `apps/gitboard/vite.config.ts`
- `apps/gitboard/vitest.config.ts`
- `apps/gitboard/src/dashboard/index.html`
- `apps/gitboard/src/dashboard/main.tsx`
- `apps/gitboard/src/dashboard/App.tsx`
- `apps/gitboard/src/dashboard/styles/globals.css`
- `apps/gitboard/src/dashboard/lib/*`
- `apps/gitboard/src/dashboard/hooks/*`
- `apps/gitboard/src/dashboard/stores/*`
- dashboard component/page slices needed for the copied shell bootstrap

Do not copy/adapt as runtime baseline:

- `Dockerfile` or `docker-compose.yml`; these are dormant reproduction tooling.
- `packages/html-preview`; it is supported auxiliary operator tooling, not a
  Console runtime dependency.
- `apps/gitboard/src/api/server.ts` into `apps/console`; API/materializer stay
  owned by the Gitboard service until a separate API split is planned.
- `substrate_*` table names as native Substrate design. They are bridge
  projection names only.

## Required References

Read before starting `forge-9xet.2`:

- `/home/dawid/second-mind/1-projects/xtrm/console/console-product-contract.md`
- `/home/dawid/second-mind/1-projects/xtrm/substrate/substrate_design_it.md`
- `apps/gitboard/design-mocks/xtrm-console-complete.html`
- `docs/architecture/console-architecture.md`
- `docs/architecture/console-test-guards.md`

## Ongoing Scaffold Rules

1. Keep `apps/console` as a separate workspace package.
2. Keep `apps/gitboard` building and serving the backend on `:3030`.
3. Keep `/console` as the product frontend and `/gitboard` as compatibility.
4. Keep API reads going through the existing Gitboard API routes.
5. Keep Beads feed grouping and inline dossier behavior stable.
6. Do not introduce a `/api/beads` dependency; project reads use
   `/api/substrate/*`.
7. Do not make Docker/Compose the primary dev/deploy path for Console.
8. Do not move materializer ownership into the Console app.

## Smoke Plan

Before scaffold:

```bash
bun run --cwd apps/gitboard typecheck
bun run --cwd apps/gitboard build:dashboard
bun run --cwd apps/gitboard test -- \
  tests/backend-boundaries/console-separation-boundary-contract.test.ts \
  tests/api/routes/beads.cache.test.ts \
  tests/api/routes/substrate.test.ts
bash apps/gitboard/tests/smoke/p6-beadboard-404.sh
bash apps/gitboard/tests/smoke/p8-runtime-artifacts.sh
```

Console validation:

```bash
bun run --cwd apps/console typecheck
bun run --cwd apps/console build
bun run --cwd apps/gitboard typecheck
bun run --cwd apps/gitboard build:dashboard
```

If `apps/console` adds tests in the scaffold slice, run the focused console test
command before any broad migration work. If it changes shared dashboard code,
also run the relevant Gitboard dashboard regression tests from
`docs/architecture/console-test-guards.md`.

## Known Blockers And Non-Blockers

Blockers for future Console frontend changes:

- Any regression in Gitboard typecheck/build.
- Any scaffold plan that makes Console own materializer/source ingestion.
- Any scaffold plan that depends on `/api/beads`.

Non-blockers for initial scaffold:

- Docker build support. Compose is classified as dormant reproduction tooling.
- Full Console visual redesign.
- Native Substrate API replacement. The bridge remains temporary until
  Substrate lands.
- Operations query lab; that is owned by `forge-9xet.4`.
