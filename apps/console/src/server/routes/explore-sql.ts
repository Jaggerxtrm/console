import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { makeLogEntry, type LogEntry } from "../../../../../packages/core/src/runtime/index.ts";
import { isLoopbackAddress, isTrustedLocalhostRequest, TRUSTED_PEER_ADDRESS_HEADER } from "../../../../../packages/core/src/runtime/console-write-policy.ts";

export interface ExploreSqlProxyOptions {
  datasetteUrl?: string;
  fetchImpl?: typeof fetch;
  emit?: (entry: LogEntry) => void;
}

const PREFIX = "/explore/sql";

export function createExploreSqlRouter(options: ExploreSqlProxyOptions = {}): Hono {
  const app = new Hono();
  const upstreamBase = normalizeBase(options.datasetteUrl ?? process.env.DATASETTE_URL ?? "http://127.0.0.1:8001");
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.emit ?? (() => {});

  const proxy = async (c: Context) => {
    const started = performance.now();
    if (!isLocalDebugRequest(c.req.raw)) {
      logProxy(log, 0, started, c.req.path, new Error("non-local debug proxy request"));
      return c.json({ ok: false, error: "datasette_debug_local_only" }, 403);
    }

    const upstream = toUpstreamUrl(c.req.url, upstreamBase);
    let upstreamStatus = 0;

    try {
      const headers = forwardedRequestHeaders(c.req.raw.headers);

      const init: RequestInit = {
        method: c.req.method,
        headers,
        body: shouldForwardBody(c.req.method) ? c.req.raw.body : undefined,
        redirect: "manual",
        duplex: "half",
      } as RequestInit;

      const upstreamResponse = await fetchImpl(upstream, init);
      upstreamStatus = upstreamResponse.status;
      logProxy(log, upstreamStatus, started, c.req.path);

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
      logProxy(log, upstreamStatus, started, c.req.path, error);
      return c.json({ ok: false, error: "datasette_unreachable" }, 502);
    }
  };

  app.all("/", proxy);
  app.all("*", proxy);

  return app;
}

export function toUpstreamUrl(requestUrl: string, upstreamBase: URL): URL {
  const request = new URL(requestUrl);
  const suffix = request.pathname.startsWith(PREFIX) ? request.pathname.slice(PREFIX.length) : request.pathname;
  const relativePath = suffix.replace(/^\/+/, "");
  const upstream = new URL(upstreamBase);
  upstream.pathname = `${upstreamBase.pathname}${relativePath}`;
  upstream.search = request.search;
  return upstream;
}

function forwardedRequestHeaders(headers: Headers): Headers {
  const forwarded = new Headers();
  for (const name of ["accept", "accept-encoding", "accept-language", "content-type", "if-modified-since", "if-none-match", "range", "user-agent"]) {
    const value = headers.get(name);
    if (value !== null) forwarded.set(name, value);
  }
  return forwarded;
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
  const peerAddress = request.headers.get(TRUSTED_PEER_ADDRESS_HEADER);
  return Boolean(peerAddress
    && isLoopbackAddress(peerAddress)
    && isTrustedLocalhostRequest(request.url, request.headers.get("host") ?? new URL(request.url).host, peerAddress));
}

function logProxy(log: (entry: LogEntry) => void, upstreamStatus: number, started: number, path: string, error?: unknown): void {
  log(makeLogEntry("explore", "proxy_request", error ? "warn" : "info", undefined, {
    upstream_status: upstreamStatus,
    duration_ms: Math.max(0, Math.round(performance.now() - started)),
    path_hash: createHash("sha256").update(path).digest("hex").slice(0, 8),
    outcome: error ? "error" : "ok",
  }));
}
