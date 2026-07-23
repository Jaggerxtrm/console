import { describe, expect, it } from "vitest";
import {
  CONSOLE_API_ROUTE_PREFIXES,
  createConsoleApiRouter,
} from "../../src/server/routes/index.ts";
import { createHostLogger } from "../../src/server/log.ts";

const silentLogger = createHostLogger({ sink: () => {} });

describe("Phase 3 Console route ownership", () => {
  it("declares every production HTTP namespace owned by apps/console", () => {
    expect(CONSOLE_API_ROUTE_PREFIXES).toEqual(expect.arrayContaining([
      "/api/github",
      "/api/specialists",
      "/api/specialists/config",
      "/api/console/specialists",
      "/api/console/observability",
      "/api/console/explore",
    ]));
  });

  it("mounts the optional Datasette proxy only when explicitly enabled", async () => {
    const disabled = createConsoleApiRouter({ db: null, logger: silentLogger });
    const enabled = createConsoleApiRouter({
      db: null,
      logger: silentLogger,
      datasetteDebugEnabled: true,
      exploreSqlOptions: { fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch },
    });

    expect((await disabled.request("http://localhost/explore/sql/")).status).toBe(404);
    expect((await enabled.request("http://localhost/explore/sql/", { headers: { "x-xtrm-peer-address": "127.0.0.1" } })).status).toBe(200);
  });

  it("does not expose terminal policy responses to hostile origins", async () => {
    const app = createConsoleApiRouter({ db: null, logger: silentLogger });
    const hostile = await app.request("http://localhost/api/console/shell/status", {
      headers: { host: "localhost", origin: "https://hostile.invalid" },
    });
    const sameOrigin = await app.request("http://localhost/api/console/shell/status", {
      headers: { host: "localhost", origin: "http://localhost" },
    });

    expect(hostile.status).toBe(200);
    expect(hostile.headers.get("access-control-allow-origin")).toBeNull();
    expect(sameOrigin.status).toBe(200);
    expect(sameOrigin.headers.get("access-control-allow-origin")).toBe("http://localhost");
  });
});
