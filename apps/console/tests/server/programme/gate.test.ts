import { describe, expect, it } from "vitest";
import { createProgrammeRouter } from "../../../src/server/programme/route.ts";
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
});
