import { open, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

export interface StaticAsset {
  readonly body: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
}

/**
 * Conservative ceiling for a single static asset, applied before any
 * allocation. Chosen above every asset in the current built console bundle
 * (largest is ~1.1 MiB) with wide headroom, so a hostile or corrupt file can
 * never force an unbounded read. `readStaticAsset` validates the real file
 * size against this value and reads at most that many bytes.
 */
export const MAX_STATIC_ASSET_BYTES = 5 * 1024 * 1024;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Reads a static asset from `distDir`, rejecting any path that escapes the
 * dist root. Containment is checked on the *real* (symlink-resolved) paths of
 * both the root and the target, so an in-root symlink whose target lives
 * outside the root is refused. The file size is validated against
 * `MAX_STATIC_ASSET_BYTES` before allocation, and at most that many bytes are
 * read, so a growing file cannot trigger an unbounded allocation (TOCTOU-safe).
 * Returns null when the file is missing, is not a regular file, escapes the
 * root, or exceeds the ceiling, so callers can fall back to the SPA index.
 */
export async function readStaticAsset(distDir: string, relativePath: string): Promise<StaticAsset | null> {
  const root = resolve(distDir);
  const resolved = resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) return null;

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpath(root);
    realTarget = await realpath(resolved);
  } catch {
    return null;
  }
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`)) return null;

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(realTarget, "r");
    const info = await handle.stat();
    if (!info.isFile()) return null;
    if (info.size > MAX_STATIC_ASSET_BYTES) return null;

    let body = new Uint8Array(info.size);
    let offset = 0;
    while (offset < body.byteLength) {
      const { bytesRead } = await handle.read(body, offset, body.byteLength - offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset < body.byteLength) body = body.subarray(0, offset);

    return { body, contentType: contentTypeFor(realTarget) };
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}
