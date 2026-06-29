import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createExploreSqlRouter, isLocalDebugRequest, toUpstreamUrl } from "../../../src/api/routes/explore-sql.ts";
import { getRing, setDiskEnabled } from "../../../src/core/logger.ts";

describe("explore SQL proxy", () => {
  it("rewrites /explore/sql paths to the Datasette upstream", () => {
    const upstream = toUpstreamUrl("http://localhost/explore/sql/foo/bar?x=1", new URL("http://127.0.0.1:8001/"));
    expect(upstream.toString()).toBe("http://127.0.0.1:8001/foo/bar?x=1");
  });

  it("streams success responses with CSP and sanitized headers", async () => {
    setDiskEnabled(false);
    const fetchImpl = vi.fn(async (url: URL, init: RequestInit) => {
      expect(url.toString()).toBe("http://datasette.test/-/databases.json");
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      expect(new Headers(init.headers).has("cookie")).toBe(false);
      return new Response(JSON.stringify({ databases: ["xtrm"] }), {
        headers: {
          "content-type": "application/json",
          "set-cookie": "secret=1",
          location: "http://datasette.test/-/metadata",
        },
      });
    });

    const app = new Hono().route("/explore/sql", createExploreSqlRouter({ datasetteUrl: "http://datasette.test", fetchImpl: fetchImpl as unknown as typeof fetch }));
    const res = await app.request("http://localhost/explore/sql/-/databases.json", {
      headers: { authorization: "Bearer secret", cookie: "sid=secret" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(res.headers.has("set-cookie")).toBe(false);
    expect(res.headers.get("location")).toBe("/explore/sql/-/metadata");
    expect(await res.json()).toEqual({ databases: ["xtrm"] });
  });

  it("rejects non-local debug proxy callers before contacting Datasette", async () => {
    setDiskEnabled(false);
    const fetchImpl = vi.fn(async () => new Response("should not happen"));
    const app = new Hono().route("/explore/sql", createExploreSqlRouter({ datasetteUrl: "http://datasette.test", fetchImpl: fetchImpl as unknown as typeof fetch }));

    const res = await app.request("http://localhost/explore/sql/-/databases.json", {
      headers: { host: "gitboard.example.com", "x-forwarded-host": "gitboard.example.com" },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "datasette_debug_local_only" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("classifies loopback hosts as local debug requests", () => {
    expect(isLocalDebugRequest(new Request("http://127.0.0.1/explore/sql"))).toBe(true);
    expect(isLocalDebugRequest(new Request("http://[::1]/explore/sql"))).toBe(true);
    expect(isLocalDebugRequest(new Request("http://localhost/explore/sql", { headers: { "x-forwarded-host": "localhost:3030" } }))).toBe(true);
    expect(isLocalDebugRequest(new Request("http://localhost/explore/sql", { headers: { "x-forwarded-host": "example.com" } }))).toBe(false);
  });

  it("converts upstream 5xx into a bounded 502 envelope and logs hashed path", async () => {
    setDiskEnabled(false);
    const fetchImpl = vi.fn(async () => new Response("raw sql error", { status: 503 }));
    const app = new Hono().route("/explore/sql", createExploreSqlRouter({ datasetteUrl: "http://datasette.test", fetchImpl: fetchImpl as unknown as typeof fetch }));

    const res = await app.request("http://localhost/explore/sql/query/private?sql=select-secret");

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "datasette_upstream_error", upstream_status: 503 });
    const line = getRing().find((entry) => entry.component === "explore" && entry.event === "proxy_request");
    expect(line?.data?.path_hash).toMatch(/^[a-f0-9]{8}$/);
    expect(JSON.stringify(line)).not.toContain("select-secret");
  });
});
