# Datasette Explore Sidecar

This sidecar is a developer/debug fallback for inspecting the xtrm materialized
SQLite database. The product `/console/explore` surface is native AgentOps UI;
Datasette is not the primary operator experience.

## Install

```bash
pipx install datasette
pipx inject datasette datasette-vega
```

Do not install mutating plugins such as `datasette-write`.

## Start

```bash
export XTRM_MATERIALIZED_DB=/path/to/xtrm.sqlite
bun run dev:datasette
```

The dev command binds `127.0.0.1:8001`, uses `tools/datasette/metadata.yml`,
sets `base_url` to `/explore/sql/`, and is intended for local inspection.

Do not mount a live SQLite database that has `*.sqlite-wal`/`*.sqlite-shm` with
`--immutable`: SQLite can ignore the WAL and report `database disk image is
malformed` even when normal read-only access works. For immutable Datasette,
create a coherent snapshot first, then mount that snapshot. For a live local DB,
use normal read-only Datasette access instead.

## Query Policy

Canned queries are mapped from `using-kpi` recipes 1-8 plus two operator navigation queries for open beads and forensic event families. Add new queries under `databases.xtrm.queries` and use Datasette `:param` placeholders for user input.

Lifecycle decision: dev-only for this MVP. A persistent systemd unit remains follow-up work in `forge-h1kg`.
