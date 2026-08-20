/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  ContextBuffer,
  addViewContext,
  buildContextBundle,
  serializeContextBundle,
  serializeContextRefs,
} from "../../../../../src/dashboard/pages/console/programme/ContextBuffer.tsx";
import { useProgrammeContext } from "../../../../../src/dashboard/pages/console/programme/context-buffer.ts";
import type { ProgrammeEdge, ProgrammeSnapshot } from "../../../../../src/types/programme.ts";

function storage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => map.set(key, value),
    removeItem: (key: string) => map.delete(key),
    clear: () => map.clear(),
  };
}

const EDGE: ProgrammeEdge = {
  source: "WS-001",
  target: "assignment:assignments/EXP-005-website-ia.yaml",
  relation: "contains",
  field: "workstream",
  strength: "strong",
};

const SNAPSHOT: ProgrammeSnapshot = {
  schema_version: 3,
  generated_at: "2026-08-14T00:00:00Z",
  programme: { repository: "mercuryintelligence/program", branch: "master", sha: "abc123def456", short_sha: "abc123d" },
  now: { title: "Now", path: "NOW.md", evidence_cutoff: "2026-08-14T00:00:00Z" },
  business: {},
  workstreams: [{
    id: "WS-001",
    graph_id: "WS-001",
    title: "Programme foundation",
    status: "ACTIVE",
    path: "workstreams/WS-001/BRIEF.md",
    has_plan: false,
    jira_refs: [],
    metadata: {},
    metadata_tree: {},
  }],
  assignments: [{
    id: "EXP-005",
    graph_id: "assignment:assignments/EXP-005-website-ia.yaml",
    kind: "EXP",
    title: "Website IA",
    status: "IN PROGRESS",
    path: "assignments/EXP-005-website-ia.yaml",
    identity_collision: true,
    jira_refs: [],
    updated_at: "2026-08-01",
    metadata: { owner: "actor-a", authority: "programme" },
    metadata_tree: {},
  }],
  research: [],
  decisions: [],
  proposals: [],
  agents: [],
  jira_refs: [],
  operator_input_refs: [],
  activity: [],
  graph: {
    nodes: [
      { id: "WS-001", kind: "workstream", title: "Programme foundation", status: "ACTIVE", source_path: "workstreams/WS-001/BRIEF.md", metadata: {}, metadata_tree: {} },
      {
        id: "assignment:assignments/EXP-005-website-ia.yaml",
        kind: "assignment",
        title: "Website IA",
        status: "IN PROGRESS",
        source_path: "assignments/EXP-005-website-ia.yaml",
        metadata: { owner: "actor-a", authority: "programme" },
        metadata_tree: {},
      },
    ],
    edges: [EDGE],
    metadata_fields: [],
    identity_collisions: [],
  },
  identity_collisions: [],
  evidence_boundary: { beads: "not inferred", runtime: "no-live-claims" },
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
  provenance: {
    current: { programme_actor_registry: false, state_actor_assignment_fields: false, wrapper_publication_facts: false, xtrm_mutation_receipts: false },
    rules: [],
    live_receipt_gate: "",
  },
  source_health: { source: "programme", status: "fresh", checked_at: "" },
} as ProgrammeSnapshot;

beforeEach(() => {
  vi.stubGlobal("sessionStorage", storage());
  vi.stubGlobal("localStorage", storage());
  useProgrammeContext.setState({ entries: [], groups: [], density: "standard" });
  window.history.pushState({}, "", "/console/programme/assignments");
});

describe("Programme Context", () => {
  it("captures collision-safe records and exact source evidence", () => {
    expect(addViewContext(SNAPSHOT, "assignments")).toBe(1);
    const state = useProgrammeContext.getState();
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].entity_key).toBe("assignment:assignments/EXP-005-website-ia.yaml");
    expect(state.entries[0].display_id).toBe("EXP-005");
    expect(state.entries[0].source_sha).toBe("abc123def456");
    expect(state.entries[0].evidence_cutoff).toBe("2026-08-14T00:00:00Z");
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0].kind).toBe("visible_selection");
  });

  it("deduplicates the entity while preserving multiple groups and relation provenance", () => {
    const node = SNAPSHOT.graph.nodes[1];
    const store = useProgrammeContext.getState();
    store.addSelection(SNAPSHOT, [node], {
      kind: "graph_path",
      label: "selected path",
      source_view: "graph",
      selectedPath: "WS-001 → EXP-005",
      selectedRelations: [EDGE],
    });
    useProgrammeContext.getState().addSelection(SNAPSHOT, [node], {
      kind: "graph_neighborhood",
      label: "selected neighborhood",
      source_view: "graph",
      derivedRelations: [EDGE],
    });

    const state = useProgrammeContext.getState();
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].group_ids).toHaveLength(2);
    expect(state.entries[0].selected_relations).toHaveLength(1);
    expect(state.entries[0].derived_relations).toHaveLength(0); // selected outranks derived
    expect(state.entries[0].selected_path).toBe("WS-001 → EXP-005");
    expect(state.groups.map((group) => group.kind).sort()).toEqual(["graph_neighborhood", "graph_path"]);
  });

  it("serializes refs/context/JSON from the same entity relation and group sets", () => {
    const node = SNAPSHOT.graph.nodes[1];
    useProgrammeContext.getState().addSelection(SNAPSHOT, [node], {
      kind: "graph_path",
      label: "implementation path",
      source_view: "graph",
      selectedRelations: [EDGE],
    });
    const state = useProgrammeContext.getState();
    const bundle = buildContextBundle(SNAPSHOT, state.entries, state.groups);
    const refs = serializeContextRefs(bundle);
    const standard = serializeContextBundle(bundle, "standard");
    const full = serializeContextBundle(bundle, "full");
    const json = JSON.parse(JSON.stringify(bundle)) as typeof bundle;

    expect(refs).toContain("mercuryintelligence/program@abc123def456/assignments/EXP-005-website-ia.yaml");
    expect(standard).toContain("MERCURY PROGRAMME CONTEXT");
    expect(standard).toContain("Evidence cutoff: 2026-08-14T00:00:00Z");
    expect(standard).toContain("implementation path [graph_path]");
    expect(standard).toContain("[selected]");
    expect(standard).toContain("UNKNOWN remains UNKNOWN");
    expect(full).toContain("metadata.owner: actor-a");
    expect(json.objects.map((entry) => entry.entity_key)).toEqual(bundle.objects.map((entry) => entry.entity_key));
    expect(json.relations.map((relation) => relation.key)).toEqual(bundle.relations.map((relation) => relation.key));
    expect(json.groups.map((group) => group.id)).toEqual(bundle.groups.map((group) => group.id));
  });

  it("opens a picker and adds only explicitly selected current-view objects", () => {
    render(<ContextBuffer snapshot={SNAPSHOT} />);
    fireEvent.click(screen.getByTitle("Expand context buffer"));
    fireEvent.click(screen.getByTitle("Select objects from current view"));
    expect(screen.getByRole("dialog", { name: "Select Programme objects for Context" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Add selected/ }));
    const state = useProgrammeContext.getState();
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].entity_key).toBe("assignment:assignments/EXP-005-website-ia.yaml");
    expect(state.groups[0].kind).toBe("table_selection");
  });

  it("removes entries without reintroducing display-id identity", () => {
    addViewContext(SNAPSHOT, "assignments");
    render(<ContextBuffer snapshot={SNAPSHOT} />);
    fireEvent.click(screen.getByTitle("Expand context buffer"));
    expect(document.querySelector('[data-entity-key="assignment:assignments/EXP-005-website-ia.yaml"]')).toBeTruthy();
    fireEvent.click(screen.getByTitle("Remove from context"));
    expect(useProgrammeContext.getState().entries).toHaveLength(0);
  });
});
