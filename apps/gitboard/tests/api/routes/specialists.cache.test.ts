import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createSpecialistsRouter } from "../../../src/api/routes/specialists.ts";

const jobs = [{ jobId: "j1", repoSlug: "repo-a", beadId: "b1", chainId: null, epicId: null, chainKind: null, status: "running", updatedAt: "2026-01-01T00:00:00.000Z", specialist: null, lastOutput: null, turns: null, tools: null, model: null }];

describe("specialists cache", () => {
  it("reuses cache across time until epoch changes", async () => {
    let epoch = 0;
    let calls = 0;
    const app = new Hono();
    app.route("/api/specialists", createSpecialistsRouter({ jobsByBead: () => [], inFlightJobs: () => { calls += 1; return jobs; }, recentJobs: () => [], chainById: () => [] }, { listRepos: () => [{ repoSlug: "repo-a", repoPath: "/tmp/repo-a", dbPath: "/tmp/repo-a.db", mtimeMs: 0 }], getEpoch: () => epoch }));
    await app.fetch(new Request("http://localhost/api/specialists/jobs/in-flight"));
    await app.fetch(new Request("http://localhost/api/specialists/jobs/in-flight"));
    expect(calls).toBe(1);
    epoch += 1;
    await app.fetch(new Request("http://localhost/api/specialists/jobs/in-flight"));
    expect(calls).toBe(2);
  });
});
