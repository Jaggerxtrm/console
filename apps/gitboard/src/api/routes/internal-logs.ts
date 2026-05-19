import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { getRing } from "../../core/logger.ts";

export function createInternalLogsRouter(): Hono {
  const app = new Hono();

  app.get("/logs", (c) => {
    if (!isLocalhost(c.req.header("host") ?? "")) return c.json({ error: "forbidden" }, 403);
    const limit = Math.min(Number(c.req.query("limit") ?? 200) || 200, 1000);
    const since = c.req.query("since");
    const level = c.req.query("level");
    const component = c.req.query("component");
    const event = c.req.query("event");
    const sinceMs = since ? Date.parse(since) : 0;
    const logs = getRing().filter((entry) => (!level || entry.level === level) && (!component || entry.component === component) && (!event || entry.event === event) && (!since || Number.isNaN(sinceMs) ? true : Date.parse(entry.ts) >= sinceMs)).slice(-limit);
    return c.json(logs);
  });

  app.get("/logs/files", (c) => {
    if (!isLocalhost(c.req.header("host") ?? "")) return c.json({ error: "forbidden" }, 403);
    const dir = process.env.LOG_DIR ?? "/data/logs";
    const files = [] as Array<{ name: string; size: number; date: string }>;
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        const file = Bun.file(join(dir, name));
        const size = statSync(join(dir, name)).size;
        files.push({ name, size, date: name.slice(0, 10) });
      }
    } catch {}
    return c.json(files);
  });

  return app;
}

function isLocalhost(host: string): boolean { return host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]"); }
