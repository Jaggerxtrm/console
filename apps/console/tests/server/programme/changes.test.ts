// Programme change/revision analysis tests (EXP-020 amendments).
// Deterministic field diffs, added/removed relations, status trails from
// observed states only, collision-safe entity keys, and no synthetic
// completion percentages.

import { describe, expect, it } from "vitest";
import { buildChangeSet, diffFields, summaryFrom } from "../../../src/server/programme/changes.ts";
import type { ProgrammeSnapshot } from "../../../src/types/programme.ts";

function snap(sha: string, nodes: Array<{ id: string; kind: string; title: string; status?: string; source_path?: string; metadata?: Record<string, unknown> }>, edges: Array<{ source: string; target: string; relation: string; field: string; strength: "strong" | "weak" }>): ProgrammeSnapshot {
  return {
    schema_version: 3,
    generated_at: `2026-08-${sha.slice(0, 2)}T00:00:00Z`,
    programme: { repository: "mercuryintelligence/program", branch: "master", sha, short_sha: sha.slice(0, 7) },
    now: { title: "", path: "NOW.md" },
    business: {},
    workstreams: [],
    assignments: [],
    research: [],
    decisions: [],
    proposals: [],
    agents: [],
    jira_refs: [],
    operator_input_refs: [],
    activity: [],
    graph: {
      nodes: nodes.map((n) => ({ ...n, source_path: n.source_path ?? null, metadata: n.metadata ?? {}, metadata_tree: {} })),
      edges,
      metadata_fields: [],
      identity_collisions: [],
    },
    identity_collisions: [],
    evidence_boundary: {},
    state_records: [],
    journals: [],
    publication_facts: [],
    state_history_semantics: {
      current_state_precedence: "",
      journal_authority: "",
      publication_separation: "",
      unsafe_nested_relationship_policy: "",
      suppressed_unsafe_nested_edges: 0,
    },
    provenance: { current: { programme_actor_registry: false, state_actor_assignment_fields: false, wrapper_publication_facts: false, xtrm_mutation_receipts: false }, rules: [], live_receipt_gate: "" },
    source_health: { source: "programme", status: "fresh", checked_at: "" },
  } as unknown as ProgrammeSnapshot;
}

describe("diffFields", () => {
  it("reports added, removed and changed fields deterministically", () => {
    const changes = diffFields({ a: 1, b: "x", c: "old" }, { b: "x", c: "new", d: true });
    expect(changes).toEqual([
      { field: "a", kind: "removed", previous: 1 },
      { field: "c", kind: "changed", previous: "old", current: "new" },
      { field: "d", kind: "added", current: true },
    ]);
  });
});

describe("buildChangeSet", () => {
  it("is deterministic and collision-safe (entity_key never display_id alone)", () => {
    const prev = snap("aaaaaaa1", [
      { id: "EXP-005", kind: "collision", title: "EXP-005 — 2 assignment records", status: "ID COLLISION" },
      { id: "assignment:assignments/EXP-005-a.yaml", kind: "assignment", title: "A", status: "READY", source_path: "assignments/EXP-005-a.yaml" },
      { id: "assignment:assignments/EXP-005-b.yaml", kind: "assignment", title: "B", status: "PROPOSED", source_path: "assignments/EXP-005-b.yaml" },
    ], []);
    const cur = snap("bbbbbbb2", [
      { id: "EXP-005", kind: "collision", title: "EXP-005 — 2 assignment records", status: "ID COLLISION" },
      { id: "assignment:assignments/EXP-005-a.yaml", kind: "assignment", title: "A", status: "CLOSED", source_path: "assignments/EXP-005-a.yaml" },
      { id: "assignment:assignments/EXP-005-b.yaml", kind: "assignment", title: "B", status: "PROPOSED", source_path: "assignments/EXP-005-b.yaml" },
    ], []);
    const set = buildChangeSet(prev, cur);
    const a = set.entities.find((e) => e.entity_key === "assignment:assignments/EXP-005-a.yaml");
    expect(a).toBeDefined();
    expect(a!.display_id).toBe("EXP-005");
    expect(a!.field_changes).toContainEqual({ field: "status", kind: "changed", previous: "READY", current: "CLOSED" });
    const a2 = set.entities.find((e) => e.entity_key === "assignment:assignments/EXP-005-b.yaml");
    expect(a2).toBeUndefined(); // unchanged record is not in the change set
    // The collision hub itself is untouched and must not absorb the change.
    const hub = set.entities.find((e) => e.entity_key === "EXP-005");
    expect(hub).toBeUndefined();
    expect(set.previous_sha).toBe("aaaaaaa1");
    expect(set.current_sha).toBe("bbbbbbb2");
  });

  it("detects added and removed relations", () => {
    const prev = snap("aaaaaaa1", [
      { id: "WS-004", kind: "workstream", title: "Education", status: "ACTIVE" },
      { id: "EXP-013", kind: "assignment", title: "Pilot", status: "READY" },
    ], [
      { source: "WS-004", target: "EXP-013", relation: "contains", field: "workstream", strength: "strong" },
    ]);
    const cur = snap("bbbbbbb2", [
      { id: "WS-004", kind: "workstream", title: "Education", status: "ACTIVE" },
      { id: "EXP-013", kind: "assignment", title: "Pilot", status: "READY" },
      { id: "EXP-014", kind: "assignment", title: "New", status: "PROPOSED" },
    ], [
      { source: "WS-004", target: "EXP-014", relation: "contains", field: "workstream", strength: "strong" },
    ]);
    const set = buildChangeSet(prev, cur);
    const ws = set.entities.find((e) => e.entity_key === "WS-004")!;
    expect(ws.relation_changes.some((r) => r.kind === "removed" && r.target === "EXP-013" && r.relation === "contains")).toBe(true);
    expect(ws.relation_changes.some((r) => r.kind === "added" && r.target === "EXP-014" && r.relation === "contains")).toBe(true);
    expect(set.relation_count).toBeGreaterThan(0);
  });

  it("status trail uses only observed states and never fabricates percentages", () => {
    const prev = snap("aaaaaaa1", [{ id: "WS-009", kind: "workstream", title: "Growth", status: "ACTIVE" }], []);
    const cur = snap("bbbbbbb2", [{ id: "WS-009", kind: "workstream", title: "Growth", status: "SUPPORTED" }], []);
    const set = buildChangeSet(prev, cur);
    const ws = set.entities.find((e) => e.entity_key === "WS-009")!;
    expect(ws.status_trail).toEqual([
      { sha: "aaaaaaa1", date: prev.generated_at, status: "ACTIVE" },
      { sha: "bbbbbbb2", date: cur.generated_at, status: "SUPPORTED" },
    ]);
    expect(JSON.stringify(set)).not.toMatch(/pct|percent|progress/);
  });

  it("summarizes changed entities and relations", () => {
    const prev = snap("aaaaaaa1", [{ id: "WS-004", kind: "workstream", title: "Education", status: "ACTIVE" }], []);
    const cur = snap("bbbbbbb2", [{ id: "WS-004", kind: "workstream", title: "Education", status: "ACTIVE" }, { id: "EXP-999", kind: "assignment", title: "X", status: "READY" }], []);
    const set = buildChangeSet(prev, cur);
    const summary = summaryFrom(set);
    expect(summary.changed_entities).toBe(1);
    expect(summary.changed_entity_keys).toEqual(["EXP-999"]);
    expect(summary.previous_sha).toBe("aaaaaaa1");
    expect(summary.current_sha).toBe("bbbbbbb2");
  });
});
