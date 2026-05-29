# @xtrm/html-preview

Small Bun/Hono server for browsing and rendering local repository documents inside a private tailnet.

## Run

```bash
bun run --filter @xtrm/html-preview start -- --root /home/dawid/dev,/home/dawid/projects --host 127.0.0.1 --port 8787
```

Then expose it privately with Tailscale Serve:

```bash
tailscale serve --bg 8787
```

## Options

- `--root`: comma-separated directories to scan for Git repositories; defaults to `/home/dawid/dev,/home/dawid/projects`
- `--host`: bind host, defaults to `127.0.0.1`
- `--port`: bind port, defaults to `8787`
- `--max-depth`: repository discovery depth, defaults to `3`
- `--max-files`: maximum indexed documents, defaults to `50000`

HTML documents render through a sandboxed iframe. Markdown renders to safe HTML with embedded raw HTML disabled. Text files render as escaped preformatted text. Raw files are served from their original repository directory so relative HTML assets such as CSS, JS, and images continue to resolve.
