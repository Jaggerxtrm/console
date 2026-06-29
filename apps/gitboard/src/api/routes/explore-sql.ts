import { createHash } from "node:crypto";
import { Hono } from "hono";
import { emit, makeLogEntry } from "../../core/logger.ts";

export interface ExploreSqlProxyOptions {
  datasetteUrl?: string;
  fetchImpl?: typeof fetch;
}

const PREFIX = "/explore/sql";

export function createExploreSqlRouter(options: ExploreSqlProxyOptions = {}): Hono {
  const app = new Hono();
  const upstreamBase = normalizeBase(options.datasetteUrl ?? process.env.DATASETTE_URL ?? "http://127.0.0.1:8001");
  const fetchImpl = options.fetchImpl ?? fetch;

  app.all("*", async (c) => {
    const started = performance.now();
    if (!isLocalDebugRequest(c.req.raw)) {
      logProxy(0, started, c.req.path, new Error("non-local debug proxy request"));
      return c.json({ ok: false, error: "datasette_debug_local_only" }, 403);
    }

    const upstream = toUpstreamUrl(c.req.url, upstreamBase);
    let upstreamStatus = 0;

    try {
      const headers = new Headers(c.req.raw.headers);
      headers.delete("authorization");
      headers.delete("cookie");

      const init: RequestInit = {
        method: c.req.method,
        headers,
        body: shouldForwardBody(c.req.method) ? c.req.raw.body : undefined,
        redirect: "manual",
        duplex: "half",
      } as RequestInit;

      const upstreamResponse = await fetchImpl(upstream, init);
      upstreamStatus = upstreamResponse.status;
      logProxy(upstreamStatus, started, c.req.path);

      if (upstreamStatus >= 500) {
        return c.json({ ok: false, error: "datasette_upstream_error", upstream_status: upstreamStatus }, 502);
      }

      const responseHeaders = sanitizeResponseHeaders(upstreamResponse.headers, upstreamBase);
      responseHeaders.set("Content-Security-Policy", "frame-ancestors 'self'");
      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      logProxy(upstreamStatus, started, c.req.path, error);
      return c.json({ ok: false, error: "datasette_unreachable" }, 502);
    }
  });

  return app;
}

export function toUpstreamUrl(requestUrl: string, upstreamBase: URL): URL {
  const request = new URL(requestUrl);
  const suffix = request.pathname.startsWith(PREFIX) ? request.pathname.slice(PREFIX.length) : request.pathname;
  const path = suffix === "" ? "/" : suffix;
  const upstream = new URL(path, upstreamBase);
  upstream.search = request.search;
  return upstream;
}

function sanitizeResponseHeaders(headers: Headers, upstreamBase: URL): Headers {
  const next = new Headers(headers);
  next.delete("authorization");
  next.delete("cookie");
  next.delete("set-cookie");
  next.delete("www-authenticate");

  const location = next.get("location");
  if (location) next.set("location", rewriteLocation(location, upstreamBase));
  return next;
}

function rewriteLocation(location: string, upstreamBase: URL): string {
  try {
    const parsed = new URL(location, upstreamBase);
    if (parsed.origin !== upstreamBase.origin) return location;
    return `${PREFIX}${parsed.pathname === "/" ? "/" : parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return location;
  }
}

function normalizeBase(value: string): URL {
  const base = new URL(value);
  if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`;
  return base;
}

function shouldForwardBody(method: string): boolean {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}

export function isLocalDebugRequest(request: Request): boolean {
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost && !isLocalHost(forwardedHost)) return false;
  return isLocalHost(request.headers.get("host") ?? new URL(request.url).host);
}

function isLocalHost(value: string): boolean {
  const host = value.trim().toLowerCase();
  if (!host) return false;
  const withoutPort = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0] ?? "";
  return ["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(withoutPort);
}

function logProxy(upstreamStatus: number, started: number, path: string, error?: unknown): void {
  emit(makeLogEntry("explore", "proxy_request", error ? "warn" : "info", undefined, {
    upstream_status: upstreamStatus,
    duration_ms: Math.max(0, Math.round(performance.now() - started)),
    path_hash: createHash("sha256").update(path).digest("hex").slice(0, 8),
    outcome: error ? "error" : "ok",
  }));
}
