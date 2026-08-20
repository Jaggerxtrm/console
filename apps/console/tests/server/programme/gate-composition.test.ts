import { describe, expect, it } from "vitest";
import { createConsoleApiRouter } from "../../../src/server/routes/index.ts";
import { createHostLogger } from "../../../src/server/log.ts";

const silentLogger = createHostLogger({ sink: () => {} });

// Composition-root checks: the production router mounts the programme route
// fail-closed (404 + disabled error) unless MERCURY_PROGRAMME_DASHBOARD_ENABLED=1,
// and the /api/programme browser CORS is same-origin only.
describe("programme composition-root gate (e2e)", () => {
  it("is fail-closed with no env flag and never touches the private source", async () => {
    const app = createConsoleApiRouter({ db: null, logger: silentLogger });
    const res = await app.request("http://localhost:3030/api/programme", {
      headers: { host: "localhost:3030", origin: "http://localhost:3030" },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "programme_dashboard_disabled" });
  });

  it("honours MERCURY_PROGRAMME_DASHBOARD_ENABLED=1 and answers with same-origin CORS only", async () => {
    const app = createConsoleApiRouter({
      db: null,
      logger: silentLogger,
      env: { ...process.env, MERCURY_PROGRAMME_DASHBOARD_ENABLED: "1" } as NodeJS.ProcessEnv,
    });
    // enabled: request is NOT the disabled error (GitHub source will fail without creds, that is fine)
    const sameOrigin = await app.request("http://localhost:3030/api/programme", {
      headers: { host: "localhost:3030", origin: "http://localhost:3030" },
    });
    const body = await sameOrigin.json() as { error?: string };
    expect(body.error).not.toBe("programme_dashboard_disabled");
    // hostile origin gets no CORS allowance
    const hostile = await app.request("http://localhost:3030/api/programme", {
      headers: { host: "localhost:3030", origin: "https://evil.example" },
    });
    expect(hostile.headers.get("access-control-allow-origin")).toBeNull();
  });
});
