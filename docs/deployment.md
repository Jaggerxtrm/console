# gitboard VPS deploy

## Prereqs
- VPS with Docker + Docker Compose plugin
- Tailscale installed on VPS, laptop, desktop
- Host Dolt server already running on VPS at `127.0.0.1:13839`
- `~/projects` on VPS contains repos to scan
- `.env` file beside `docker-compose.yml` with `GITHUB_TOKEN=...`

## Build + run
```bash
docker compose build
docker compose up -d
docker compose logs -f gitboard
```

Dashboard: `http://<vps-host>:3000/gitboard`

## Tailscale enrolment
1. Install Tailscale on VPS, laptop, desktop.
2. Sign all 3 into same tailnet.
3. Enable MagicDNS in admin console.
4. Use VPS tailnet name: `http://<vps-tailscale-name>:3000/gitboard`

## Firewall lockdown
Keep port 3000 off public internet. Allow only Tailscale.

### ufw
```bash
sudo ufw deny 3000/tcp
sudo ufw allow in on tailscale0 to any port 3000 proto tcp
sudo ufw status verbose
```

If ufw runs default deny, keep `3000/tcp` closed on public iface and let `tailscale0` pass.

## Troubleshooting
### Container cannot reach Dolt
- Confirm host Dolt is up: `curl http://127.0.0.1:13839`
- Confirm compose uses host networking
- Confirm no other service stole `13839`

### GitHub rate-limit / auth fail
- Verify `.env` has valid `GITHUB_TOKEN`
- Refresh token if `GithubPoller` logs 403/429

### Port already bound
- Find process: `sudo ss -ltnp | grep ':3000'`
- Stop old gitboard or move current service
- Re-run `docker compose up -d`

## Checks
```bash
curl http://127.0.0.1:3000/gitboard
curl http://127.0.0.1:3000/api/internal/dolt-health
```
