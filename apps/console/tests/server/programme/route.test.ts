// /api/programme route contract tests: exact-head pinning, snapshot delivery,
// graph integrity, source health, and degraded last-good behavior.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createProgrammeRouter } from "../../../src/server/programme/route.ts";
import { createMapProgrammeSource, type ProgrammeSource } from "../../../src/server/programme/read-model.ts";
import type { ProgrammeSnapshotResponse } from "../../../src/types/programme.ts";
import type { ObservableProgrammeSource } from "../../../src/server/programme/source.ts";

const FIXTURE_ROOT = join(__dirname, "..", "..", "fixtures", "programme");

function fixtureSource(): ProgrammeSource {
  const files = new Map<string, string>([
    ["NOW.md", readFileSync(join(FIXTURE_ROOT, "NOW.md"), "utf-8")],
    ["workstreams/WS-004-education-revenue/BRIEF.md", readFileSync(join(FIXTURE_ROOT, "workstreams/WS-004-education-revenue/BRIEF.md"), "utf-8")],
    ["workstreams/WS-009-mercury-business-continuity-growth/STATE.md", readFileSync(join(FIXTURE_ROOT, "workstreams/WS-009-mercury-business-continuity-growth/STATE.md"), "utf-8")],
    ["workstreams/WS-009-mercury-business-continuity-growth/PLAN.md", readFileSync(join(FIXTURE_ROOT, "workstreams/WS-009-mercury-business-continuity-growth/PLAN.md"), "utf-8")],
    ["assignments/EXP-013-education-student-derivative-pilot.yaml", readFileSync(join(FIXTURE_ROOT, "assignments/EXP-013-education-student-derivative-pilot.yaml"), "utf-8")],
    ["assignments/OPS-010-activate-mercury-hive-head-and-growth-loop.yaml", readFileSync(join(FIXTURE_ROOT, "assignments/OPS-010-activate-mercury-hive-head-and-growth-loop.yaml"), "utf-8")],
    ["decisions/ADR-0004-mercury-business-continuity-and-hive-head.md", readFileSync(join(FIXTURE_ROOT, "decisions/ADR-0004-mercury-business-continuity-and-hive-head.md"), "utf-8")],
    ["agents/registry.yaml", readFileSync(join(FIXTURE_ROOT, "agents/registry.yaml"), "utf-8")],
    ["state/web-programme-supervisor.json", readFileSync(join(FIXTURE_ROOT, "state/web-programme-supervisor.json"), "utf-8")],
  ]);
  return createMapProgrammeSource(files, {
    activity: [{ sha: "abc1234", date: "2026-08-15T00:00:00Z", subject: "synthetic commit", url: "https://example.invalid/commit/abc1234" }],
  });
}

function failingSource(): ProgrammeSource {
  const base = fixtureSource();
  return { ...base, read: async () => { throw new Error("simulated GitHub outage"); } };
}

let app: ReturnType<typeof createProgrammeRouter>;
let failingApp: ReturnType<typeof createProgrammeRouter>;

beforeAll(() => {
  app = createProgrammeRouter({ source: fixtureSource(), cacheTtlMs: 60_000 });
  failingApp = createProgrammeRouter({ source: failingSource(), cacheTtlMs: 60_000 });
});

describe("GET /api/programme", () => {
  it("serves a v3 snapshot with source health", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = await res.json() as ProgrammeSnapshotResponse;
    expect(body.snapshot).not.toBeNull();
    expect(body.snapshot!.schema_version).toBe(3);
    expect(body.freshness).toBe("fresh");
    expect(body.source_health.source).toBe("programme");
    expect(body.source_health.status).toBe("fresh");
  });

  it("exposes required regression relations through the route", async () => {
    const res = await app.request("/");
    const body = await res.json() as ProgrammeSnapshotResponse;
    const keys = new Set(body.snapshot!.graph.edges.map((e) => `${e.source}\u0001${e.target}\u0001${e.relation}`));
    expect(keys.has("WS-004\u0001EXP-013\u0001contains")).toBe(true);
    expect(keys.has("ADR-0004\u0001OPS-010\u0001authorizes")).toBe(true);
    expect(keys.has("program-coordinator-web\u0001state:web-programme-supervisor\u0001materializes_state")).toBe(true);
  });

  it("reports degraded with no synthetic empty snapshot when the initial source fails", async () => {
    const res = await failingApp.request("/");
    expect(res.status).toBe(200);
    const body = await res.json() as ProgrammeSnapshotResponse;
    expect(body.snapshot).toBeNull();
    expect(body.freshness).toBe("degraded");
    expect(body.source_health.status).toBe("degraded");
    expect(body.error).toContain("simulated GitHub outage");
  });

  it("serves WS-009 STATE precedence through the route", async () => {
    const res = await app.request("/");
    const body = await res.json() as ProgrammeSnapshotResponse;
    expect(body.snapshot!.business.baseline_customers).toBe(9);
    expect(body.snapshot!.business.baseline_evidence_class).toBe("SUPPORTED");
  });

  it("pins one exact source SHA and reports that SHA instead of a separately observed activity head", async () => {
    const base = fixtureSource();
    const pinned = { ...base, pinnedSha: "0123456789abcdef" } as ObservableProgrammeSource;
    const pinnable = { ...base, pin: async () => pinned } as ObservableProgrammeSource;
    const pinnedApp = createProgrammeRouter({ source: pinnable, cacheTtlMs: 60_000 });
    const res = await pinnedApp.request("/");
    const body = await res.json() as ProgrammeSnapshotResponse;
    expect(body.snapshot!.programme.sha).toBe("0123456789abcdef");
    expect(body.snapshot!.programme.short_sha).toBe("0123456");
  });

  it("keeps the last-good snapshot readable but marks a failed forced refresh degraded", async () => {
    const base = fixtureSource();
    let fail = false;
    const flapping: ProgrammeSource = {
      ...base,
      read: async (path) => {
        if (fail) throw new Error("refresh failed");
        return base.read(path);
      },
    };
    const flappingApp = createProgrammeRouter({ source: flapping, cacheTtlMs: 60_000 });
    const first = await flappingApp.request("/");
    const firstBody = await first.json() as ProgrammeSnapshotResponse;
    expect(firstBody.freshness).toBe("fresh");
    const firstAssignments = firstBody.snapshot!.assignments.length;

    fail = true;
    const second = await flappingApp.request("/?refresh=true");
    const secondBody = await second.json() as ProgrammeSnapshotResponse;
    expect(secondBody.freshness).toBe("degraded");
    expect(secondBody.source_health.status).toBe("degraded");
    expect(secondBody.error).toContain("refresh failed");
    expect(secondBody.snapshot!.assignments.length).toBe(firstAssignments);
  });

  it("treats a swallowed optional-directory transport failure as degraded rather than a fresh partial snapshot", async () => {
    const base = fixtureSource();
    let sourceError: string | null = null;
    const partial = {
      ...base,
      listDir: async (path: string) => {
        if (path === "research") {
          sourceError = "synthetic research directory timeout";
          throw new Error(sourceError);
        }
        return base.listDir(path);
      },
      sourceError: () => sourceError,
    } as ObservableProgrammeSource;
    const partialApp = createProgrammeRouter({ source: partial, cacheTtlMs: 60_000 });
    const res = await partialApp.request("/");
    const body = await res.json() as ProgrammeSnapshotResponse;
    expect(body.snapshot).toBeNull();
    expect(body.freshness).toBe("degraded");
    expect(body.source_health.status).toBe("degraded");
    expect(body.error).toContain("Programme source incomplete");
  });
});

describe("GET /api/programme/changes and /revisions", () => {
  it("returns an empty change set on first observation (no previous revision)", async () => {
    const res = await app.request("/changes");
    expect(res.status).toBe(200);
    const body = await res.json() as { previous_sha: string | null; entities: unknown[] };
    expect(body.previous_sha).toBeNull();
    expect(body.entities).toEqual([]);
  });

  it("reports a deterministic change set after a second build and includes it in the summary", async () => {
    const base = fixtureSource();
    let flip = false;
    const evolving: ProgrammeSource = {
      ...base,
      read: async (path) => {
        if (path === "assignments/EXP-013-education-student-derivative-pilot.yaml" && flip) {
          return (await base.read(path) ?? "").replace(/status:\s*ready/i, "status: closed");
        }
        return base.read(path);
      },
    };
    const evolvingApp = createProgrammeRouter({ source: evolving, cacheTtlMs: 60_000 });
    const first = await evolvingApp.request("/");
    const firstBody = await first.json() as ProgrammeSnapshotResponse;
    expect(firstBody.changes_summary).toBeNull();
    flip = true;
    const second = await evolvingApp.request("/?refresh=true");
    const secondBody = await second.json() as ProgrammeSnapshotResponse;
    expect(secondBody.changes_summary).not.toBeNull();
    expect(secondBody.changes_summary!.changed_entities).toBeGreaterThan(0);
    const changeRes = await evolvingApp.request("/changes");
    expect(changeRes.status).toBe(200);
    const changeBody = await changeRes.json() as { entities: Array<{ entity_key: string; field_changes: unknown[] }> };
    expect(changeBody.entities.length).toBe(secondBody.changes_summary!.changed_entities);
    const exp013 = changeBody.entities.find((e) => e.entity_key === "EXP-013");
    expect(exp013).toBeDefined();
    expect(exp013!.field_changes.some((f) => (f as { field: string }).field === "status")).toBe(true);
  });

  it("revisions endpoint requires a path and fails closed when disabled", async () => {
    const missing = await app.request("/revisions");
    expect(missing.status).toBe(400);
    const disabled = createProgrammeRouter({ source: fixtureSource(), enabled: false });
    const res = await disabled.request("/revisions?path=NOW.md");
    expect(res.status).toBe(404);
  });

  it("changes endpoint fails closed when disabled", async () => {
    const disabled = createProgrammeRouter({ source: fixtureSource(), enabled: false });
    const res = await disabled.request("/changes");
    expect(res.status).toBe(404);
  });
});
