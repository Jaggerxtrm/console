import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { makeLogEntry, type LogEntry } from "../../../../../packages/core/src/runtime/index.ts";
import { isLocalhost, isLoopbackAddress, TRUSTED_PEER_ADDRESS_HEADER } from "../../../../../packages/core/src/runtime/console-write-policy.ts";

const MAX_CLIENT_LOG_BODY_BYTES = 64 * 1024;
const MAX_CLIENT_LOG_DEPTH = 4;
const MAX_CLIENT_LOG_KEYS = 50;
const MAX_CLIENT_LOG_ARRAY = 20;
const MAX_CLIENT_LOG_STRING = 2_000;
const SENSITIVE_LOG_KEY = /token|secret|password|authorization|cookie|credential/i;

export interface InternalLogsRuntime {
  emit(entry: LogEntry): void;
  getRing(): LogEntry[];
  getLogDiskDir(): string;
}

export function createInternalLogsRouter(runtime: InternalLogsRuntime): Hono {
  const app = new Hono();

  app.get("/logs", (c) => {
    if (!isAllowedReadRequest(c.req.url, c.req.header("host"), c.req.header("origin"), c.req.header("x-gitboard-internal-logs-token"), c.req.header(TRUSTED_PEER_ADDRESS_HEADER))) return c.json({ error: "forbidden" }, 403);
    const requestedLimit = Number(c.req.query("limit") ?? 200);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(Math.trunc(requestedLimit), 1000)) : 200;
    const since = c.req.query("since");
    const level = c.req.query("level");
    const component = c.req.query("component");
    const event = c.req.query("event");
    const sinceMs = since ? Date.parse(since) : 0;
    const logs = runtime.getRing().filter((entry) => (!level || entry.level === level) && (!component || entry.component === component) && (!event || entry.event === event) && (!since || Number.isNaN(sinceMs) ? true : Date.parse(entry.ts) >= sinceMs)).slice(-limit);
    return c.json(logs);
  });

  app.get("/logs/files", (c) => {
    if (!isAllowedReadRequest(c.req.url, c.req.header("host"), c.req.header("origin"), c.req.header("x-gitboard-internal-logs-token"), c.req.header(TRUSTED_PEER_ADDRESS_HEADER))) return c.json({ error: "forbidden" }, 403);
    const dir = runtime.getLogDiskDir();
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
    if (!isAllowedClientWriteRequest(c.req.url, c.req.header("host"), c.req.header("origin"), c.req.header("x-gitboard-internal-logs-token"), c.req.header(TRUSTED_PEER_ADDRESS_HEADER))) {
      return c.json({ ok: false, error: "forbidden" }, 403);
    }

    const text = await readBoundedText(c.req.raw, MAX_CLIENT_LOG_BODY_BYTES);
    if (text == null) return c.json({ ok: false, error: "Payload too large" }, 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ ok: false, error: "Invalid JSON" }, 400);
    }

    const payload = body && typeof body === "object" ? body as { event?: unknown; data?: unknown } : {};
    const event = typeof payload.event === "string" ? payload.event.slice(0, 120) : "ui.unknown";
    const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? sanitizeLogValue(payload.data) as Record<string, unknown>
      : {};

    runtime.emit(makeLogEntry("drawer", event, "info", undefined, {
      ...data,
      source: "dashboard-client",
    }));

    return c.json({ ok: true });
  });

  return app;
}

function isAllowedReadRequest(url: string, host: string | undefined, origin: string | undefined, token: string | undefined, peerAddress: string | undefined): boolean {
  if (hasValidInternalLogsToken(token)) return true;
  if (!hostMatchesUrl(url, host) || !isTrustedPeerForClaimedHost(url, host, peerAddress)) return false;
  if (!origin) return isLocalhostHost(host ?? "");
  return isSameOrigin(url, origin);
}

function isAllowedClientWriteRequest(url: string, host: string | undefined, origin: string | undefined, token: string | undefined, peerAddress: string | undefined): boolean {
  if (hasValidInternalLogsToken(token)) return true;
  return Boolean(origin && hostMatchesUrl(url, host) && isTrustedPeerForClaimedHost(url, host, peerAddress) && isSameOrigin(url, origin));
}

function isTrustedPeerForClaimedHost(url: string, host: string | undefined, peerAddress: string | undefined): boolean {
  if (!peerAddress) return true;
  try {
    const claimsLocalhost = isLocalhost(host ?? "") || isLocalhost(new URL(url).hostname);
    return !claimsLocalhost || isLoopbackAddress(peerAddress);
  } catch {
    return false;
  }
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

async function readBoundedText(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function sanitizeLogValue(value: unknown, depth = 0, key = ""): unknown {
  if (SENSITIVE_LOG_KEY.test(key)) return "[REDACTED]";
  if (depth >= MAX_CLIENT_LOG_DEPTH) return "[TRUNCATED]";
  if (typeof value === "string") {
    if (/^(?:\/|[A-Za-z]:[\\/])/.test(value)) return "[REDACTED_PATH]";
    return value.slice(0, MAX_CLIENT_LOG_STRING);
  }
  if (Array.isArray(value)) return value.slice(0, MAX_CLIENT_LOG_ARRAY).map((item) => sanitizeLogValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, MAX_CLIENT_LOG_KEYS).map(([childKey, child]) => [childKey, sanitizeLogValue(child, depth + 1, childKey)]));
  }
  return value;
}
