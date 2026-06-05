# @xtrm/console

Gradual Console scaffold seeded from `apps/gitboard`.

This package is a frontend-only Vite app for `forge-9xet.2`. It intentionally
does not own API composition, materializer lifecycle, source ingestion, Docker
deployment, or the production `:3030` Gitboard service.

## Development

Run the existing Gitboard service/API first, then start the Console frontend:

```bash
bun run --cwd apps/gitboard dev
bun run --cwd apps/console dev
```

Vite serves Console on `http://localhost:5174/console/` and proxies `/api` and
`/ws` to the Gitboard service on `localhost:3030`.

## Validation

```bash
bun run --cwd apps/console typecheck
bun run --cwd apps/console build
bun run --cwd apps/gitboard typecheck
bun run --cwd apps/gitboard build:dashboard
```

## References

- `docs/architecture/apps-console-scaffold-preflight.md`
- `/home/dawid/second-mind/1-projects/xtrm/console/console-product-contract.md`
- `/home/dawid/second-mind/1-projects/xtrm/substrate/substrate_design_it.md`
