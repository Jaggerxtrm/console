// Programme read-model regression tests (EXP-020).
// Build the v3 snapshot from vendored governed fixtures and assert the canonical
// regression relations, collision/identity semantics, subject-aware nested
// relations, state/journal/publication continuity, WS-009 STATE precedence,
// identity/provenance UNKNOWN boundaries, and no-dangling-edge integrity.
// Hermetic: no network; fixtures live in apps/console/tests/fixtures/programme.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildProgrammeSnapshot,
  createMapProgrammeSource,
  enrichProgrammeSnapshot,
  assertNoDanglingEdges,
  type ProgrammeSource,
} from "../../../src/server/programme/read-model.ts";
import type { ProgrammeSnapshot } from "../../../src/types/programme.ts";

const FIXTURE_ROOT = join(__dirname, "..", "..", "fixtures", "programme");

function collectFixtureFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else files.set(rel, readFileSync(full, "utf-8"));
    }
  };
  walk(FIXTURE_ROOT, "");
  return files;
}

let source: ProgrammeSource;
let snapshot: ProgrammeSnapshot;

beforeAll(async () => {
  source = createMapProgrammeSource(collectFixtureFiles(), {
    repository: "mercuryintelligence/program",
    branch: "master",
    activity: [{ sha: "abc1234", date: "2026-08-15T00:00:00Z", subject: "test commit", url: "https://example.com/commit/abc1234" }],
  });
  const raw = await buildProgrammeSnapshot(source);
  snapshot = await enrichProgrammeSnapshot(raw, source);
  assertNoDanglingEdges(snapshot.graph);
});

afterAll(() => {});

describe("programme read model schema", () => {
  it("produces a v3 snapshot", () => {
    expect(snapshot.schema_version).toBe(3);
    expect(snapshot.base_schema_version).toBe(2);
    expect(snapshot.programme.repository).toBe("mercuryintelligence/program");
  });

  it("records canonical entities", () => {
    expect(snapshot.workstreams.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.assignments.length).toBeGreaterThanOrEqual(8);
    expect(snapshot.decisions.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.research.length).toBeGreaterThanOrEqual(3);
    expect(snapshot.agents.length).toBeGreaterThanOrEqual(7);
    expect(snapshot.state_records.length).toBe(2);
    expect(snapshot.journals.length).toBeGreaterThanOrEqual(3);
    expect(snapshot.publication_facts.length).toBeGreaterThan(0);
  });
});

describe("programme graph regressions (canonical required relations)", () => {
  const edgeKeys = () => new Set(snapshot.graph.edges.map((e) => `${e.source}\u0001${e.target}\u0001${e.relation}`));

  it("WS-004 -> EXP-013 contains", () => {
    expect(edgeKeys().has("WS-004\u0001EXP-013\u0001contains")).toBe(true);
  });
  it("EXP-010 -> EXP-013 precedes", () => {
    expect(edgeKeys().has("EXP-010\u0001EXP-013\u0001precedes")).toBe(true);
  });
  it("mercury-hive-head -> program-coordinator-web projection (no reverse)", () => {
    expect(edgeKeys().has("mercury-hive-head\u0001program-coordinator-web\u0001projection")).toBe(true);
    expect(edgeKeys().has("program-coordinator-web\u0001mercury-hive-head\u0001projection")).toBe(false);
  });
  it("ADR-0004 -> OPS-010 authorizes (outer-record-owned nested field preserved)", () => {
    expect(edgeKeys().has("ADR-0004\u0001OPS-010\u0001authorizes")).toBe(true);
  });
  it("program-coordinator-web -> OPS-009 assignment (registry truth)", () => {
    expect(edgeKeys().has("program-coordinator-web\u0001OPS-009\u0001assignment")).toBe(true);
  });
  it("program-coordinator-web -> state:web-programme-supervisor materializes_state", () => {
    expect(edgeKeys().has("program-coordinator-web\u0001state:web-programme-supervisor\u0001materializes_state")).toBe(true);
  });
  it("OPS-009 -> state:web-programme-supervisor state_snapshot", () => {
    expect(edgeKeys().has("OPS-009\u0001state:web-programme-supervisor\u0001state_snapshot")).toBe(true);
  });
});

describe("identity and relationship semantics", () => {
  it("preserves EXP-005 assignment collision with path-qualified records", () => {
    const hub = snapshot.graph.nodes.find((n) => n.id === "EXP-005");
    expect(hub?.kind).toBe("collision");
    const dupes = snapshot.assignments.filter((a) => a.id === "EXP-005");
    expect(dupes.length).toBe(2);
    for (const d of dupes) {
      expect(d.graph_id).not.toBe("EXP-005");
      const node = snapshot.graph.nodes.find((n) => n.id === d.graph_id);
      expect(node?.kind).toBe("assignment");
    }
    expect(snapshot.identity_collisions.some((c) => c.id === "EXP-005")).toBe(true);
  });

  it("separates EXP-004 research evidence artifacts from the executable assignment", () => {
    const assignmentNode = snapshot.graph.nodes.find((n) => n.id === "EXP-004");
    expect(assignmentNode?.kind).toBe("assignment");
    const some = snapshot.identity_collisions.some((c) => c.id === "EXP-004");
    expect(some).toBe(false);
    for (const r of snapshot.research.filter((r) => r.id === "EXP-004")) {
      expect(r.graph_id).not.toBe("EXP-004");
      expect(r.graph_id.startsWith("research:")).toBe(true);
      const node = snapshot.graph.nodes.find((n) => n.id === r.graph_id);
      expect(node?.kind).toBe("research");
    }
  });

  it("does not attribute embedded-record relations to the outer entity (subject-aware)", () => {
    const keys = new Set(snapshot.graph.edges.map((e) => `${e.source}\u0001${e.target}\u0001${e.relation}`));
    expect(keys.has("OPS-010\u0001program-coordinator-web\u0001projection")).toBe(false);
    expect(keys.has("operator-dawid\u0001OPS-010\u0001parent")).toBe(false);
    expect(keys.has("program-coordinator-web\u0001OPS-009\u0001parent")).toBe(false);
  });

  it("preserves other true outer-record-owned nested relations", () => {
    const keys = new Set(snapshot.graph.edges.map((e) => `${e.source}\u0001${e.target}\u0001${e.relation}`));
    expect(keys.has("ADR-0003\u0001OPS-009\u0001authorizes")).toBe(true);
    expect(keys.has("EXP-012\u0001mercuryintelligence/darth-feedor\u0001repository")).toBe(true);
    expect(keys.has("OPS-010\u0001ISSUE-85\u0001portfolio")).toBe(true);
    expect(keys.has("mercury-hive-head\u0001OPS-010\u0001assignment")).toBe(true);
    expect(keys.has("program-coordinator-host\u0001OPS-008\u0001assignment")).toBe(true);
    expect(keys.has("hive-research\u0001EXP-011\u0001assignment")).toBe(true);
  });

  it("has no dangling edge endpoints", () => {
    const ids = new Set(snapshot.graph.nodes.map((n) => n.id));
    for (const e of snapshot.graph.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });

  it("keeps strong/weak distinction and source-field provenance on strong edges", () => {
    const strong = snapshot.graph.edges.filter((e) => e.strength === "strong");
    expect(strong.length).toBeGreaterThan(0);
    expect(strong.every((e) => e.field && e.field.length > 0)).toBe(true);
    const weak = snapshot.graph.edges.filter((e) => e.strength === "weak");
    expect(weak.length).toBeGreaterThan(0);
  });
});

describe("state / journal / publication continuity", () => {
  it("records wrapper publication facts from coordinator state with UNKNOWN actor/principal", () => {
    expect(snapshot.publication_facts.length).toBeGreaterThan(0);
    for (const p of snapshot.publication_facts) {
      expect(p.logical_actor).toBe("UNKNOWN");
      expect(p.principal_set).toBe("UNKNOWN");
      expect(p.evidence_class).toBe("wrapper_recorded_state");
    }
  });

  it("publishes records_publication edges from state:coordinator", () => {
    const keys = new Set(snapshot.graph.edges.map((e) => `${e.source}\u0001${e.relation}`));
    expect(keys.has("state:coordinator\u0001records_publication")).toBe(true);
  });

  it("links paired journal run outputs to coordinator state", () => {
    const keys = new Set(snapshot.graph.edges.map((e) => `${e.source}\u0001${e.target}\u0001${e.relation}`));
    expect([...keys].some((k) => k.endsWith("\u0001paired_run_output"))).toBe(true);
  });

  it("does not emit published_run edges to nonexistent assignment nodes", () => {
    const ids = new Set(snapshot.graph.nodes.map((n) => n.id));
    for (const e of snapshot.graph.edges.filter((e) => e.relation === "published_run")) {
      expect(ids.has(e.source)).toBe(true);
    }
  });
});

describe("WS-009 current-state precedence", () => {
  it("uses the current accepted STATE baseline (9, SUPPORTED) not the historical PLAN baseline (8)", () => {
    const b = snapshot.business;
    expect(b.baseline_customers).toBe(9);
    expect(b.baseline_evidence_class).toBe("SUPPORTED");
    expect(b.baseline_source).toBe("workstreams/WS-009-mercury-business-continuity-growth/STATE.md");
    expect(b.target_customers).toBe(50);
    expect(b.deadline).toBe("2026-11-07");
  });
});

describe("identity & provenance UNKNOWN boundaries", () => {
  it("reports xtrm_mutation_receipts as false and never infers a principal or receipt", () => {
    expect(snapshot.provenance.current.xtrm_mutation_receipts).toBe(false);
    expect(snapshot.provenance.current.programme_actor_registry).toBe(true);
  });

  it("declares the no-inference attribution rules", () => {
    const rules = snapshot.provenance.rules.join(" ");
    expect(rules.toLowerCase()).toContain("never infer a logical actor");
    expect(rules.toLowerCase()).toContain("never infer a credential principal");
    expect(snapshot.provenance.live_receipt_gate.length).toBeGreaterThan(0);
  });

  it("does not fabricate execution/receipt nodes (only state/journal/publication kinds) for provenance", () => {
    const provenanceKinds = new Set(snapshot.graph.nodes.filter((n) => ["state", "journal", "publication"].includes(n.kind)).map((n) => n.kind));
    expect(provenanceKinds).toEqual(new Set(["state", "journal", "publication"]));
  });
});

describe("determinism", () => {
  it("builds an identical graph/edge ordering on a second run", async () => {
    const raw2 = await buildProgrammeSnapshot(source);
    const snap2 = await enrichProgrammeSnapshot(raw2, source);
    expect(snap2.graph.nodes.map((n) => n.id)).toEqual(snapshot.graph.nodes.map((n) => n.id));
    expect(snap2.graph.edges.map((e) => `${e.source}->${e.target}:${e.relation}`)).toEqual(
      snapshot.graph.edges.map((e) => `${e.source}->${e.target}:${e.relation}`),
    );
  });
});
