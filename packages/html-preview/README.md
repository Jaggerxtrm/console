# @xtrm/html-preview

Small Bun/Hono server for browsing and rendering local repository HTML files inside a private tailnet.

## Run

```bash
bun run --filter @xtrm/html-preview start -- --root /home/dawid/dev --host 127.0.0.1 --port 8787
```

Then expose it privately with Tailscale Serve:

```bash
tailscale serve --bg 8787
```

## Options

- `--root`: directory to scan for Git repositories
- `--host`: bind host, defaults to `127.0.0.1`
- `--port`: bind port, defaults to `8787`
- `--max-depth`: repository discovery depth, defaults to `3`
- `--max-files`: maximum indexed HTML files, defaults to `600`

HTML documents render through a sandboxed iframe. Raw files are served from their original repository directory so relative assets such as CSS, JS, and images continue to resolve.
