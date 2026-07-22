import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createSpecialistsRouter } from "../../../src/api/routes/specialists.ts";
import type { SpecialistJob } from "../../../src/server/observability/types.ts";

const job: SpecialistJob = {
  jobId: "job-1",
  repoSlug: "repo-a",
  beadId: "bead-1",
  chainId: "chain-1",
  epicId: "epic-1",
  chainKind: "executor",
  status: "running",
  updatedAt: "2026-01-01T00:00:00.000Z",
  specialist: "executor",
  lastOutput: null,
  turns: null,
  tools: null,
  model: null,
};

describe("specialists in-flight memory bound", () => {
  function makeApp(reads: { inFlight: () => void; history: (limit: number) => void }): Hono {
    const app = new Hono();
    app.route("/api/specialists", createSpecialistsRouter({
      jobsByBead: () => [],
      inFlightJobs: () => {
        reads.inFlight();
        return [job];
      },
      recentJobs: (limit) => {
        reads.history(limit);
        return [];
      },
      chainById: () => [],
    }, {
      listRepos: () => [{ repoSlug: "repo-a", repoPath: "repo-a", dbPath: "repo-a.db", mtimeMs: 0 }],
      getEpoch: () => 0,
    }));
    return app;
  }

  it("deduplicates concurrent cold reads", async () => {
    let inFlightReads = 0;
    let historyReads = 0;
    const app = makeApp({ inFlight: () => { inFlightReads += 1; }, history: () => { historyReads += 1; } });

    const responses = await Promise.all(
      Array.from({ length: 32 }, () => app.fetch(new Request("http://localhost/api/specialists/jobs/in-flight"))),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(inFlightReads).toBe(1);
    expect(historyReads).toBe(1);
  });

  it("retains separate bounded cache entries for polling limits", async () => {
    const limits: number[] = [];
    const app = makeApp({ inFlight: () => {}, history: (limit) => { limits.push(limit); } });

    for (let index = 0; index < 100; index += 1) {
      const limit = index % 2 === 0 ? 50 : 1000;
      const response = await app.fetch(new Request(`http://localhost/api/specialists/jobs/in-flight?limit=${limit}`));
      expect(response.status).toBe(200);
    }

    expect(limits).toEqual([50, 1000]);
  });
});
