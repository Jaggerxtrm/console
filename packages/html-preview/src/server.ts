import { serve } from "bun";
import { Hono } from "hono";
import { extname } from "node:path";
import { readFile } from "node:fs/promises";
import { scanHtmlDocuments } from "./scanner.ts";
import { renderIndex, renderNotFound, renderViewer } from "./ui.ts";
import { safeJoin } from "./security.ts";
import type { HtmlDocumentEntry, HtmlPreviewOptions, PreviewIndex } from "./types.ts";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

export function createHtmlPreviewApp(options: HtmlPreviewOptions): Hono {
  const app = new Hono();
  let currentIndex: PreviewIndex | null = null;

  async function getIndex(force = false): Promise<PreviewIndex> {
    if (!currentIndex || force) {
      currentIndex = await scanHtmlDocuments(options);
    }
    return currentIndex;
  }

  app.get("/", async (c) => c.html(renderIndex(await getIndex())));

  app.get("/api/index", async (c) => c.json(await getIndex()));

  app.post("/api/refresh", async (c) => {
    await getIndex(true);
    return c.redirect("/");
  });

  app.get("/view", async (c) => {
    const index = await getIndex();
    const repoId = c.req.query("repo");
    const path = c.req.query("path");
    const document = findDocument(index, repoId, path);

    if (!document) {
      return c.html(renderNotFound("The requested HTML document is not in the current index."), 404);
    }

    return c.html(renderViewer(index, document));
  });

  app.get("/raw/:repoId/*", async (c) => {
    const index = await getIndex();
    const repoId = c.req.param("repoId");
    const repo = index.repos.find((entry) => entry.id === repoId);
    const filePath = c.req.path.slice(`/raw/${repoId}/`.length);

    if (!repo || filePath.length === 0) {
      return c.text("Not found", 404);
    }

    const absolutePath = safeJoin(repo.path, decodeURIComponent(filePath));
    if (!absolutePath) {
      return c.text("Invalid path", 400);
    }

    try {
      const file = await readFile(absolutePath);
      return new Response(file, {
        headers: {
          "Content-Type": MIME_TYPES[extname(absolutePath).toLowerCase()] ?? "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return c.text("Not found", 404);
    }
  });

  return app;
}

export function startHtmlPreviewServer(options: HtmlPreviewOptions): void {
  const app = createHtmlPreviewApp(options);
  serve({
    hostname: options.host,
    port: options.port,
    fetch: app.fetch,
  });

  console.log(`html-preview listening on http://${options.host}:${options.port}`);
  console.log(`scanning ${options.root}`);
}

function findDocument(index: PreviewIndex, repoId?: string, path?: string): HtmlDocumentEntry | null {
  if (!repoId || !path) {
    return null;
  }
  return index.documents.find((document) => document.repoId === repoId && document.path === path) ?? null;
}
