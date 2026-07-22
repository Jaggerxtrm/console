import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

export interface StaticAsset {
  readonly body: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
}

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
 * dist root (path-traversal guard). Returns null when the file is missing or
 * is not a regular file so callers can fall back to the SPA index.
 */
export async function readStaticAsset(distDir: string, relativePath: string): Promise<StaticAsset | null> {
  const root = resolve(distDir);
  const resolved = resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) return null;

  try {
    const info = await stat(resolved);
    if (!info.isFile()) return null;
    const buffer = await readFile(resolved);
    const body = new Uint8Array(buffer.byteLength);
    body.set(buffer);
    return { body, contentType: contentTypeFor(resolved) };
  } catch {
    return null;
  }
}
