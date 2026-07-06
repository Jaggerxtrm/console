import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { emit, getLogDiskDir, getRing, makeLogEntry } from "../../core/logger.ts";

export function createInternalLogsRouter(): Hono {
  const app = new Hono();

  app.get("/logs", (c) => {
    if (!isAllowedReadRequest(c.req.url, c.req.header("host"), c.req.header("origin"), c.req.header("x-gitboard-internal-logs-token"))) return c.json({ error: "forbidden" }, 403);
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
    if (!isAllowedReadRequest(c.req.url, c.req.header("host"), c.req.header("origin"), c.req.header("x-gitboard-internal-logs-token"))) return c.json({ error: "forbidden" }, 403);
    const dir = getLogDiskDir();
    const files = [] as Array<{ name: string; size: number; date: string }>;
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        const size = statSync(join(dir, name)).size;
        files.push({ name, size, date: name.slice(0, 10) });
      }
    } catch {}
    return c.json(files);
  });

  app.post("/logs/client", async (c) => {
    if (!isAllowedClientWriteRequest(c.req.url, c.req.header("host"), c.req.header("origin"), c.req.header("x-gitboard-internal-logs-token"))) {
      return c.json({ ok: false, error: "forbidden" }, 403);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "Invalid JSON" }, 400);
    }

    const payload = body && typeof body === "object" ? body as { event?: unknown; data?: unknown } : {};
    const event = typeof payload.event === "string" ? payload.event.slice(0, 120) : "ui.unknown";
    const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? payload.data as Record<string, unknown>
      : {};

    emit(makeLogEntry("drawer", event, "info", undefined, {
      ...data,
      source: "dashboard-client",
    }));

    return c.json({ ok: true });
  });

  return app;
}

function isAllowedReadRequest(url: string, host: string | undefined, origin: string | undefined, token: string | undefined): boolean {
  if (hasValidInternalLogsToken(token)) return true;
  if (!hostMatchesUrl(url, host)) return false;
  if (!origin) return isLocalhostHost(host ?? "");
  return isSameOrigin(url, origin);
}

function isAllowedClientWriteRequest(url: string, host: string | undefined, origin: string | undefined, token: string | undefined): boolean {
  if (hasValidInternalLogsToken(token)) return true;
  return Boolean(origin && hostMatchesUrl(url, host) && isSameOrigin(url, origin));
}

function hasValidInternalLogsToken(token: string | undefined): boolean {
  const configuredToken = process.env.GITBOARD_INTERNAL_LOGS_TOKEN ?? process.env.GITBOARD_SOURCES_ADMIN_TOKEN ?? "";
  return configuredToken.length > 0 && token === configuredToken;
}

function hostMatchesUrl(url: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    return normalizeHost(host) === normalizeHost(new URL(url).host);
  } catch {
    return false;
  }
}

function isLocalhostHost(host: string): boolean {
  const normalized = hostName(host);
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "[::1]";
}

function isSameOrigin(url: string, origin: string): boolean {
  try {
    const requestUrl = new URL(url);
    const originUrl = new URL(origin);
    return requestUrl.protocol === originUrl.protocol && normalizeHost(requestUrl.host) === normalizeHost(originUrl.host);
  } catch {
    return false;
  }
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/:80$/, "").replace(/:443$/, "");
}

function hostName(host: string): string {
  const normalized = normalizeHost(host);
  if (normalized.startsWith("[")) return normalized.slice(0, normalized.indexOf("]") + 1);
  return normalized.split(":")[0] ?? normalized;
}
