import { describe, expect, it } from "vitest";
import { createProgrammeRouter } from "../../../src/server/programme/route.ts";
import { createMapProgrammeSource, type ProgrammeSource } from "../../../src/server/programme/read-model.ts";
import type { ProgrammeActivity, ProgrammeChangeSet } from "../../../src/types/programme.ts";
import type { ObservableProgrammeSource } from "../../../src/server/programme/source.ts";

function files(status: string): Map<string, string> {
  return new Map([
    ["NOW.md", "# NOW\n\nEvidence cutoff: 2026-08-20T00:00:00Z\n"],
    ["assignments/EXP-020-dashboard.yaml", `id: EXP-020\ntitle: Dashboard\nstatus: ${status}\nworkstream: WS-001\n`],
    ["workstreams/WS-001-program-bootstrap/BRIEF.md", "---\nid: WS-001\nstatus: ACTIVE\n---\n# WS-001 — Programme\n\nCurrent assignment: EXP-020\n"],
  ]);
}

function activity(sha: string, date: string): ProgrammeActivity {
  return { sha, date, subject: `state ${sha}`, url: `https://example.test/${sha}` };
}

function mapSource(status: string, sha: string, date: string): ProgrammeSource {
  return createMapProgrammeSource(files(status), {
    repository: "mercuryintelligence/program",
    branch: "master",
    activity: [activity(sha, date)],
  });
}

function historicalSource(): ObservableProgrammeSource {
  const current = mapSource("CLOSED", "bbbbbbb2", "2026-08-20T08:00:00Z") as ObservableProgrammeSource;
  const previous = mapSource("READY", "aaaaaaa1", "2026-08-13T08:00:00Z") as ObservableProgrammeSource;
  current.atRef = async (ref) => {
    if (ref.toLowerCase().startsWith("aaaaaaa1")) return previous;
    if (ref.toLowerCase().startsWith("bbbbbbb2")) return current;
    throw new Error(`unknown ref ${ref}`);
  };
  current.commitAtOrBefore = async () => activity("aaaaaaa1", "2026-08-13T08:00:00Z");
  return current;
}

describe("programme historical compare API", () => {
  it("compares an explicit prior SHA against the exact current snapshot", async () => {
    const app = createProgrammeRouter({ source: historicalSource(), cacheTtlMs: 60_000 });
    const response = await app.request("/compare?from=aaaaaaa1&to=bbbbbbb2");
    expect(response.status).toBe(200);
    const body = await response.json() as ProgrammeChangeSet;
    expect(body.previous_sha).toBe("aaaaaaa1");
    expect(body.current_sha).toBe("bbbbbbb2");
    const exp = body.entities.find((entity) => entity.entity_key === "EXP-020");
    expect(exp?.field_changes).toContainEqual({ field: "status", kind: "changed", previous: "READY", current: "CLOSED" });
  });

  it("resolves time windows to a real historical programme commit", async () => {
    const app = createProgrammeRouter({ source: historicalSource(), cacheTtlMs: 60_000 });
    const response = await app.request("/compare?window=7d");
    expect(response.status).toBe(200);
    const body = await response.json() as ProgrammeChangeSet;
    expect(body.previous_sha).toBe("aaaaaaa1");
    expect(body.current_sha).toBe("bbbbbbb2");
    expect(body.entities.some((entity) => entity.entity_key === "EXP-020")).toBe(true);
  });

  it("rejects non-commit textual refs instead of pretending to compare", async () => {
    const app = createProgrammeRouter({ source: historicalSource(), cacheTtlMs: 60_000 });
    const response = await app.request("/compare?from=master");
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toContain("hexadecimal commit SHA");
  });
});
