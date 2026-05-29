# fix.md — known issues & recovery commands

## Port 443 conflict: `@xtrm/html-preview` vs Mercury Traefik

### Symptom

Mercury Traefik (in `~/projects/mercury/infra`) fails to start with:

```
failed to bind host port 0.0.0.0:443/tcp: address already in use
```

Or: Grafana / Traefik dashboard / Portainer return `403 Forbidden` from
the home network even though the admin allowlist looks correct.

### Root cause

`packages/html-preview/README.md` historically documented:

```bash
tailscale serve --bg 8787
```

`tailscale serve` defaults to HTTPS on host port **443**. This silently
steals the port from Mercury Traefik. The conflict only surfaces when
Traefik is **recreated** (not just restarted) — e.g. after `docker
compose up -d traefik` to pick up a new `.env` value.

Related gotcha: `docker compose restart traefik` does **not** re-read
the `.env` file. Environment variables inside the container stay frozen
at the values present when the container was originally `up`. To
propagate a new `.env` you must `docker compose up -d traefik`, which
recreates the container — and that's exactly when the 443 conflict
bites.

### Fix (canonical — apply once)

Change the html-preview Tailscale Serve setup to use **8443** instead
of the default 443:

```bash
sudo tailscale serve reset
sudo tailscale serve --bg --https=8443 http://127.0.0.1:8787
```

Tailscale Serve only supports HTTPS on ports `443`, `8443`, or `10000`.
`8443` is the cleanest off-default choice. The tailnet URL becomes:

```
https://<host>.<tailnet>.ts.net:8443
```

Then bring Mercury Traefik back up:

```bash
docker compose -f ~/projects/mercury/infra/docker-compose.yml up -d traefik
```

### Verify

```bash
ss -tlnp | grep ':443'                       # only Mercury Traefik
tailscale serve status                       # shows :8443 → 127.0.0.1:8787
docker ps --filter name=traefik              # status: healthy
```

### Why not the other direction

Mercury Traefik is the public ingress (Grafana, Portainer, MCP servers,
website). It must keep the standard HTTPS port 443. html-preview is a
private tailnet tool used by one person — moving it to 8443 is the
right tradeoff.

### Files to keep in sync

- `packages/html-preview/README.md` line ~14 — must show
  `tailscale serve --bg --https=8443 8787`, not the default-443 form.
- This file.

### History

- 2026-05-29: First hit. Mercury Traefik recreated to pick up rotated
  home IPv6 prefix `ADMIN_CIDR_V6=2a0e:436:f611::/48` in `.env`.
  Recreate failed because html-preview had grabbed 443 via
  `tailscale serve --bg 8787`. Resolution: moved html-preview to 8443.
