import { describe, expect, it } from "vitest";
import { createApp } from "../../../src/api/server.ts";

describe("terminal routes", () => {
  it("returns terminal provider status from shared registry", async () => {
    const { app } = createApp({} as never);
    const res = await app.request("/api/console/terminal/status");
    expect(res.status).toBe(200);
    const json = await res.json() as { providers: Array<{ kind: string; enabled: boolean }> };
    expect(json.providers.some((provider) => provider.kind === "pty")).toBe(true);
    expect(json.providers.some((provider) => provider.kind === "specialist-feed" && provider.enabled)).toBe(true);
  });
});
