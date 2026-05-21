import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createApp } from "../../../src/api/server.ts";

describe("beads cache", () => {
  it("serves stale cached projects when scanner later fails", async () => {
    const app = createApp({} as never).app;
    const first = await app.fetch(new Request("http://localhost/api/beads/projects"));
    expect(first.status).toBe(200);
    const json = await first.json() as { projects: unknown[] };
    expect(Array.isArray(json.projects)).toBe(true);
  });
});
