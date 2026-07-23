# Console deployment

Primary deploy path: native Bun process under a systemd user service, exposed
only through Tailscale on host. The production host is the Console host.

## Native systemd user service

Create `~/.config/systemd/user/console.service`:

```ini
[Unit]
Description=xtrm Console host
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/dev/console
Environment=HOST=100.113.49.52
Environment=PORT=3030
Environment=XTRM_DATA_DIR=%h/dev/console/data
ExecStart=/home/dawid/.bun/bin/bun /home/dawid/dev/console/apps/console/src/server/index.ts
Restart=always

[Install]
WantedBy=default.target
```

`/gitboard*` responds with a permanent `308` redirect to `/console`.
