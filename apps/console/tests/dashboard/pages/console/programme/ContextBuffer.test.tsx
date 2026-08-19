/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ContextBuffer, addViewContext } from "../../../../../src/dashboard/pages/console/programme/ContextBuffer.tsx";
import { useProgrammeContext } from "../../../../../src/dashboard/pages/console/programme/context-buffer.ts";
import type { ProgrammeSnapshot } from "../../../../../src/types/programme.ts";

function storage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => map.set(key, value),
    removeItem: (key: string) => map.delete(key),
    clear: () => map.clear(),
  };
}

const SNAPSHOT: ProgrammeSnapshot = {
  schema_version: 3,
  generated_at: "2026-08-14T00:00:00Z",
  programme: { repository: "mercuryintelligence/program", branch: "master", sha: "abc123def456", short_sha: "abc123d" },
  now: { title: "Now", path: "NOW.md" },
  business: {},
  workstreams: [],
  assignments: [
    {
      id: "EXP-005",
      graph_id: "assignment:assignments/EXP-005-website-ia.yaml",
      kind: "EXP",
      title: "Website IA",
      status: "IN PROGRESS",
      path: "assignments/EXP-005-website-ia.yaml",
      identity_collision: true,
      jira_refs: [],
      updated_at: "2026-08-01",
      metadata: {},
      metadata_tree: {},
    },
  ],
  research: [],
  decisions: [],
  proposals: [],
  agents: [],
  jira_refs: [],
  operator_input_refs: [],
  activity: [],
  graph: {
    nodes: [
      {
        id: "assignment:assignments/EXP-005-website-ia.yaml",
        kind: "assignment",
        title: "Website IA",
        status: "IN PROGRESS",
        source_path: "assignments/EXP-005-website-ia.yaml",
        metadata: {},
        metadata_tree: {},
      },
    ],
    edges: [],
    metadata_fields: [],
    identity_collisions: [],
  },
  identity_collisions: [],
  evidence_boundary: { beads: "read@abc", runtime: "no-live-claims" },
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
    current: {
      programme_actor_registry: false,
      state_actor_assignment_fields: false,
      wrapper_publication_facts: false,
      xtrm_mutation_receipts: false,
    },
    rules: [],
    live_receipt_gate: "",
  },
  source_health: { source: "programme", status: "fresh", checked_at: "" },
} as unknown as ProgrammeSnapshot;

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("sessionStorage", storage());
  useProgrammeContext.setState({ entries: [], density: "standard" });
  window.history.pushState({}, "", "/console/programme/assignments");
});

describe("ContextBuffer", () => {
  it("addViewContext captures the view records keyed by entity_key", () => {
    expect(addViewContext(SNAPSHOT, "assignments")).toBe(1);
    const entries = useProgrammeContext.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].entity_key).toBe("assignment:assignments/EXP-005-website-ia.yaml");
    expect(entries[0].display_id).toBe("EXP-005");
    expect(entries[0].path).toBe("assignments/EXP-005-website-ia.yaml");
    expect(entries[0].source_view).toBe("assignments");
    expect(entries[0].source_sha).toBe("abc123def456");
  });

  it("renders captured entries keyed by entity_key and removes them", () => {
    addViewContext(SNAPSHOT, "assignments");
    render(<ContextBuffer snapshot={SNAPSHOT} />);
    fireEvent.click(screen.getByTitle("Expand context buffer"));
    expect(screen.getByText("EXP-005")).toBeTruthy();
    expect(screen.getByText("assignments/EXP-005-website-ia.yaml")).toBeTruthy();
    const row = document.querySelector('[data-entity-key="assignment:assignments/EXP-005-website-ia.yaml"]');
    expect(row).toBeTruthy();
    fireEvent.click(screen.getByTitle("Remove from context"));
    expect(useProgrammeContext.getState().entries).toHaveLength(0);
    expect(document.querySelector('[data-entity-key="assignment:assignments/EXP-005-website-ia.yaml"]')).toBeNull();
  });

  it("Copy JSON produces a JSON document containing the entity_key", () => {
    addViewContext(SNAPSHOT, "assignments");
    render(<ContextBuffer snapshot={SNAPSHOT} />);
    fireEvent.click(screen.getByTitle("Expand context buffer"));
    fireEvent.click(screen.getByRole("button", { name: "Copy JSON" }));
    expect(screen.getByRole("status").textContent).toBe("Copied");
    const raw = sessionStorage.getItem("programme:context-buffer:v1");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(String(raw)) as Array<{ entity_key: string }>;
    expect(parsed[0].entity_key).toBe("assignment:assignments/EXP-005-website-ia.yaml");
  });

  it("density toggle switches classes on the buffer entries", () => {
    addViewContext(SNAPSHOT, "assignments");
    render(<ContextBuffer snapshot={SNAPSHOT} />);
    fireEvent.click(screen.getByTitle("Expand context buffer"));
    const entry = document.querySelector('[data-entity-key="assignment:assignments/EXP-005-website-ia.yaml"]');
    expect(entry?.className).toContain("pg-buffer-entry-standard");
    fireEvent.click(screen.getByRole("button", { name: "Full" }));
    expect(entry?.className).toContain("pg-buffer-entry-full");
    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    expect(entry?.className).toContain("pg-buffer-entry-compact");
  });
});
