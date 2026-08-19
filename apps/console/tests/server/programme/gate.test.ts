import { describe, expect, it } from "vitest";
import { createProgrammeRouter, isAllowedProgrammeOrigin } from "../../../src/server/programme/route.ts";
import type { ProgrammeSource } from "../../../src/server/programme/read-model.ts";

describe("programme deployment exposure gate", () => {
  it("is fail-closed when explicitly disabled and does not touch the private source", async () => {
    let sourceCalls = 0;
    const source: ProgrammeSource = {
      repository: "mercuryintelligence/program",
      branch: "master",
      read: async () => { sourceCalls += 1; throw new Error("must not read while disabled"); },
      listDir: async () => { sourceCalls += 1; throw new Error("must not list while disabled"); },
      recentCommits: async () => { sourceCalls += 1; throw new Error("must not query while disabled"); },
    };
    const app = createProgrammeRouter({ source, enabled: false });
    const res = await app.request("/");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "programme_dashboard_disabled" });
    expect(sourceCalls).toBe(0);
  });

  it("allows only the Console origin for browser CORS reads", () => {
    expect(isAllowedProgrammeOrigin("https://console.internal.example", "console.internal.example")).toBe(true);
    expect(isAllowedProgrammeOrigin("http://127.0.0.1:3030", "127.0.0.1:3030")).toBe(true);
    expect(isAllowedProgrammeOrigin("https://evil.example", "console.internal.example")).toBe(false);
    expect(isAllowedProgrammeOrigin(null, "console.internal.example")).toBe(false);
    expect(isAllowedProgrammeOrigin("not a url", "console.internal.example")).toBe(false);
  });
});
