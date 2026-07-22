import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { getRing, setDiskEnabled } from "../../../src/core/logger.ts";
import { createSpecialistsRouter, MAX_IN_FLIGHT_REFRESHES, MAX_REPO_SLUG_FILTERS, MAX_REPO_SLUG_FILTER_BYTES } from "../../../src/api/routes/specialists.ts";
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

  it("emits bounded response telemetry with cacheable specialist fields", async () => {
    setDiskEnabled(false);
    const before = getRing().length;
    const app = makeApp({ inFlight: () => {}, history: () => {} });

    const response = await app.fetch(new Request("http://localhost/api/specialists/jobs/in-flight"));
    const entry = getRing().slice(before).find((item) => item.event === "specialists.in_flight.response");

    expect(response.status).toBe(200);
    expect(entry).toMatchObject({
      component: "api",
      event: "specialists.in_flight.response",
      level: "info",
      data: expect.objectContaining({
        freshness: "fresh",
        jobs: 1,
        recentHistory: 0,
        beadIds: ["bead-1"],
        repoSlugs: ["repo-a"],
        jobIds: ["job-1"],
        statuses: { running: 1 },
        epoch: { "repo-a": 0 },
        summaries: [expect.objectContaining({ jobId: "job-1", beadId: "bead-1", repoSlug: "repo-a" })],
      }),
    });
    expect(entry).not.toHaveProperty("lastOutput");
  });

  it("cleans failed refresh so next request invokes DAO and succeeds", async () => {
    let inFlightCalls = 0;
    const app = makeApp({
      inFlight: () => {
        inFlightCalls += 1;
        if (inFlightCalls === 1) throw new Error("refresh failed");
      },
      history: () => {},
    });

    const failed = await app.fetch(new Request("http://localhost/api/specialists/jobs/in-flight"));
    const retry = await app.fetch(new Request("http://localhost/api/specialists/jobs/in-flight"));

    expect(failed.status).toBe(500);
    expect(retry.status).toBe(200);
    expect(inFlightCalls).toBe(2);
  });

  it("evicts least-recently-used entry at two-entry bound", async () => {
    const limits: number[] = [];
    const app = makeApp({ inFlight: () => {}, history: (limit) => { limits.push(limit); } });

    for (const limit of [1, 2, 1, 3, 1, 2]) {
      const response = await app.fetch(new Request(`http://localhost/api/specialists/jobs/in-flight?limit=${limit}`));
      expect(response.status).toBe(200);
    }

    // 1 is refreshed before 3 arrives, so 2 is evicted; 2 then requires refresh.
    expect(limits).toEqual([1, 2, 3, 2]);
  });

  it("treats limit zero as empty history and keeps zero distinct from default cache key", async () => {
    const limits: number[] = [];
    const app = makeApp({ inFlight: () => {}, history: (limit) => { limits.push(limit); } });

    const zero = await app.fetch(new Request("http://localhost/api/specialists/jobs/in-flight?limit=0"));
    const defaultLimit = await app.fetch(new Request("http://localhost/api/specialists/jobs/in-flight"));

    expect(zero.status).toBe(200);
    expect(defaultLimit.status).toBe(200);
    expect((await zero.json()).recent_history).toEqual([]);
    expect(limits).toEqual([0, 50]);
  });

  it("rejects malformed limits to fallback and clamps valid integers", async () => {
    const cases: Array<[raw: string, expected: number]> = [
      ["%20", 50],
      ["%09", 50],
      ["3.5", 50],
      ["-1", 50],
      ["abc", 50],
      ["0", 0],
      ["250", 250],
      ["9999", 5000],
    ];

    for (const [raw, expected] of cases) {
      const limits: number[] = [];
      const app = makeApp({ inFlight: () => {}, history: (limit) => { limits.push(limit); } });
      const response = await app.fetch(new Request(`http://localhost/api/specialists/jobs/in-flight?limit=${raw}`));
      expect(response.status).toBe(200);
      expect(limits).toEqual([expected]);
    }
  });

  it("collapses malformed limits onto the default cache key without churning", async () => {
    const limits: number[] = [];
    const app = makeApp({ inFlight: () => {}, history: (limit) => { limits.push(limit); } });

    for (const raw of ["%20", "%09", "3.5", "abc", ""]) {
      const response = await app.fetch(new Request(`http://localhost/api/specialists/jobs/in-flight?limit=${raw}`));
      expect(response.status).toBe(200);
    }

    expect(limits).toEqual([50]);
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

  it("caps concurrent distinct in-flight refreshes and degrades excess without DAO calls", async () => {
    let daoCalls = 0;
    const app = makeApp({ inFlight: () => { daoCalls += 1; }, history: () => {} });

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        app.fetch(new Request(`http://localhost/api/specialists/jobs/in-flight?limit=${i + 1}`)),
      ),
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(daoCalls).toBeLessThanOrEqual(MAX_IN_FLIGHT_REFRESHES);
    expect(daoCalls).toBeGreaterThan(0);

    for (const response of responses) {
      const body = await response.json();
      expect(body).toHaveProperty("in_flight");
      expect(body).toHaveProperty("recent_history");
      expect(body).toHaveProperty("jobs");
      expect(body).toHaveProperty("epoch");
      expect(body).toHaveProperty("freshness");
      expect(body).toHaveProperty("source_health");
    }
  });

  it("excess distinct repo_slug keys do not invoke DAO beyond cap", async () => {
    let daoCalls = 0;
    const app = makeApp({ inFlight: () => { daoCalls += 1; }, history: () => {} });

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        app.fetch(new Request(`http://localhost/api/specialists/jobs/in-flight?repo_slug=hostile-${i}`)),
      ),
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(daoCalls).toBeLessThanOrEqual(MAX_IN_FLIGHT_REFRESHES);
  });

  it("bounds repo_slug filter count before DAO invocation", async () => {
    const capturedFilters: Array<readonly string[] | undefined> = [];
    const app = new Hono();
    app.route("/api/specialists", createSpecialistsRouter({
      jobsByBead: () => [],
      inFlightJobs: (filter) => { capturedFilters.push(filter?.repoSlugs); return [job]; },
      recentJobs: () => [],
      chainById: () => [],
    }, {
      listRepos: () => [{ repoSlug: "repo-a", repoPath: "repo-a", dbPath: "repo-a.db", mtimeMs: 0 }],
      getEpoch: () => 0,
    }));

    const slugs = Array.from({ length: 100 }, (_, i) => `repo-${i}`).join(",");
    const response = await app.fetch(new Request(`http://localhost/api/specialists/jobs/in-flight?repo_slug=${slugs}`));

    expect(response.status).toBe(200);
    expect(capturedFilters.length).toBe(1);
    expect(capturedFilters[0]!.length).toBeLessThanOrEqual(MAX_REPO_SLUG_FILTERS);
  });

  it("bounds repo_slug total bytes before cache-key construction", async () => {
    const capturedFilters: Array<readonly string[] | undefined> = [];
    const app = new Hono();
    app.route("/api/specialists", createSpecialistsRouter({
      jobsByBead: () => [],
      inFlightJobs: (filter) => { capturedFilters.push(filter?.repoSlugs); return [job]; },
      recentJobs: () => [],
      chainById: () => [],
    }, {
      listRepos: () => [{ repoSlug: "repo-a", repoPath: "repo-a", dbPath: "repo-a.db", mtimeMs: 0 }],
      getEpoch: () => 0,
    }));

    const slugs = Array.from({ length: 10 }, (_, i) => `repo-${"x".repeat(200)}-${i}`).join(",");
    const response = await app.fetch(new Request(`http://localhost/api/specialists/jobs/in-flight?repo_slug=${slugs}`));

    expect(response.status).toBe(200);
    expect(capturedFilters.length).toBe(1);
    const totalBytes = capturedFilters[0]!.reduce((sum, s) => sum + Buffer.byteLength(s, "utf8"), 0);
    expect(totalBytes).toBeLessThanOrEqual(MAX_REPO_SLUG_FILTER_BYTES);
  });

  it("canonicalizes equivalent repo_slug filters to same cache key", async () => {
    let daoCalls = 0;
    const app = makeApp({ inFlight: () => { daoCalls += 1; }, history: () => {} });

    const r1 = await app.fetch(new Request("http://localhost/api/specialists/jobs/in-flight?repo_slug=beta,alpha"));
    const r2 = await app.fetch(new Request("http://localhost/api/specialists/jobs/in-flight?repo_slug=alpha,beta"));

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(daoCalls).toBe(1);
  });

  it("recovers refresh capacity after settlement", async () => {
    let daoCalls = 0;
    const app = makeApp({ inFlight: () => { daoCalls += 1; }, history: () => {} });

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        app.fetch(new Request(`http://localhost/api/specialists/jobs/in-flight?limit=${i + 1}`)),
      ),
    );

    const callsAfterSaturation = daoCalls;

    const response = await app.fetch(new Request("http://localhost/api/specialists/jobs/in-flight?limit=999"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.freshness).toBe("fresh");
    expect(daoCalls).toBe(callsAfterSaturation + 1);
  });
});
