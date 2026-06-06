# @xtrm/console

Ready xtrm Console frontend app.

This package is a frontend-only Vite app. The production backend serves the
built app at `/console`. It intentionally does not own API composition,
materializer lifecycle, source ingestion, Docker deployment, or the native
`:3030` backend service.

## Development

Run the existing backend/API first, then start the Console frontend:

```bash
bun run --cwd apps/gitboard dev
bun run --cwd apps/console dev
```

Vite serves Console on `http://localhost:5174/console/` and proxies `/api` and
`/ws` to the backend service on `localhost:3030`.

## Validation

```bash
bun run --cwd apps/console typecheck
bun run --cwd apps/console build
bun run --cwd apps/gitboard typecheck
bun run --cwd apps/gitboard build:dashboard
```

Production smoke after the backend is restarted:

```bash
curl -fsS http://<tailnet-ip>:3030/console
curl -fsS http://<tailnet-ip>:3030/health
```

## References

- `docs/architecture/apps-console-scaffold-preflight.md`
- `/home/dawid/second-mind/1-projects/xtrm/console/console-product-contract.md`
- `/home/dawid/second-mind/1-projects/xtrm/substrate/substrate_design_it.md`
