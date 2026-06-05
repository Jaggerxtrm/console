import { describe, expect, it } from "vitest";
import { createApp } from "../../../src/api/server.ts";

describe("legacy beads route", () => {
  it("keeps /api/beads retired and serves project reads through /api/substrate", async () => {
    const app = createApp({} as never).app;

    const legacy = await app.fetch(new Request("http://localhost/api/beads/projects"));
    expect(legacy.status).toBe(404);

    const current = await app.fetch(new Request("http://localhost/api/substrate/projects"));
    expect(current.status).toBe(200);
    const json = await current.json() as { projects: unknown[] };
    expect(Array.isArray(json.projects)).toBe(true);
  });
});
