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
    expect((await enabled.request("http://localhost/explore/sql/")).status).toBe(200);
  });
});
