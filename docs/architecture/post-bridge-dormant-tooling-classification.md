# Post-Bridge Dormant Tooling Classification

Status: current classification for `forge-benk.9`.

Primary runtime remains the native Bun `apps/gitboard` service under systemd on
the Tailscale host. Tooling below must not be copied into `apps/console` as a
runtime requirement unless a future scaffold task explicitly opts in.

## Classification

| Tool | Status | Owner | Keep/Refresh/Remove | Validation path | Console scaffold rule |
|---|---|---|---|---|---|
| `packages/html-preview` | Supported auxiliary tooling | Operator docs/design-preview workflow | Keep supported | `bun run --filter @xtrm/html-preview lint`; `bun run --filter @xtrm/html-preview test` | Do not copy into `apps/console`; keep as workspace package callable by operators |
| `Dockerfile` | Dormant local reproduction path | Ops cleanup | Keep dormant | `docker compose config`; optional `docker build .` before claiming support | Do not treat as production deploy; native systemd remains the scaffold baseline |
| `docker-compose.yml` | Dormant local reproduction path | Ops cleanup | Keep dormant | `docker compose config`; optional `docker compose build` before claiming support | Do not copy Compose assumptions into Console env defaults |

## Decisions

`packages/html-preview` stays because it is a useful private tailnet document
viewer for local repository HTML, Markdown and text files. It is not part of the
running Gitboard/Console service, but it is a supported operator tool with its
own package scripts and tests.

Docker and Compose stay in the tree as explicit local-reproduction tooling. They
remain secondary to the native systemd/Tailscale deploy path and intentionally
use `PORT=3000`, `GITBOARD_DATA_DIR=/data`, and
`XDG_PROJECTS_DIR=/projects`. Compose treats `.env` as optional so `docker
compose config` remains a cheap classification guard on machines without local
secrets.

No removal bead is created from this classification because none of the three
tools are removal candidates right now. A future cleanup may create a dedicated
refresh/removal bead if Docker stops building or if `html-preview` loses its
operator workflow.

## Scaffold Gate

`forge-9xet.2` should treat these as inputs:

1. Source runtime baseline: `apps/gitboard`, not Docker.
2. Deployment baseline: native systemd/Tailscale from `docs/deployment.md`.
3. Workspace tooling: `packages/html-preview` can remain shared, but Console
   should not depend on it at runtime.
4. Reproduction tooling: Docker/Compose may be smoke-checked, but failures
   should not block the initial `apps/console` scaffold unless the scaffold
   explicitly changes container support.
