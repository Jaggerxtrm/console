/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type {
  ProgrammeChangeSet,
  ProgrammeEntityChange,
  ProgrammeRevisionHistory,
  ProgrammeSnapshot,
} from "../../../../../src/types/programme.ts";
import { ChangesView } from "../../../../../src/dashboard/pages/console/programme/ChangesView.tsx";

function snapshot(): ProgrammeSnapshot {
  return {
    schema_version: 1,
    generated_at: "2025-01-01T00:00:00.000Z",
    programme: { repository: "mercuryintelligence/program", branch: "master", sha: "aaaa", short_sha: "aaaa" },
    now: { title: "now", path: ".xtrm/now.md" },
    business: {
      target_customers: 50,
      baseline_customers: 3,
      deadline: "2026-11-07",
      evidence_note: "op",
      baseline_evidence_class: "C",
      baseline_source: "op",
    },
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
      nodes: [
        { id: "assignment:assignments/EXP-005.yaml", kind: "assignment", title: "EXP-005 record", source_path: "assignments/EXP-005.yaml" },
      ],
      edges: [],
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
    source_health: { source: "programme-github", status: "fresh", checked_at: "2025-01-01T00:00:00.000Z", message: "" },
  };
}

const entities: ProgrammeEntityChange[] = [
  {
    entity_key: "assignment:assignments/EXP-005.yaml",
    display_id: "EXP-005",
    kind: "assignment",
    title: "EXP-005 record",
    path: "assignments/EXP-005.yaml",
    field_changes: [
      { field: "status", kind: "changed", previous: "proposed", current: "accepted" },
      { field: "owner", kind: "added", current: "hive-head" },
    ],
    relation_changes: [
      { source: "assignment:assignments/EXP-005.yaml", target: "WS-009", relation: "belongs_to", field: "workstream", strength: "strong", kind: "added" },
      { source: "assignment:assignments/EXP-005.yaml", target: "WS-004", relation: "belongs_to", field: "workstream", strength: "strong", kind: "removed" },
    ],
    status_trail: [
      { sha: "aaaa1111", date: "2025-01-01T09:00:00.000Z", status: "proposed" },
      { sha: "bbbb2222", date: "2025-01-01T10:00:00.000Z", status: "accepted" },
    ],
    previous_revision_sha: "aaaa1111",
    current_revision_sha: "bbbb2222",
  },
  {
    entity_key: "WS-009",
    display_id: "WS-009",
    kind: "workstream",
    title: "Business continuity",
    path: "workstreams/WS-009.yaml",
    field_changes: [],
    relation_changes: [],
    status_trail: [],
    previous_revision_sha: null,
    current_revision_sha: null,
  },
];

const changeSet: ProgrammeChangeSet = {
  previous_sha: "aaaa1111",
  current_sha: "bbbb2222",
  generated_at: "2025-01-01T12:00:00.000Z",
  entities,
  relation_count: 2,
};

const revisionHistory: ProgrammeRevisionHistory = {
  entity_key: "assignment:assignments/EXP-005.yaml",
  path: "assignments/EXP-005.yaml",
  revisions: [
    { sha: "bbbb2222", date: "2025-01-01T10:00:00.000Z", subject: "accept EXP-005", url: "https://github.com/mercuryintelligence/program/commit/bbbb2222" },
  ],
  current_revision_sha: "bbbb2222",
  previous_revision_sha: "aaaa1111",
};

function fetchOk(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => fetchOk(revisionHistory)));
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChangesView", () => {
  it("renders entity rows keyed by entity_key with field diff, grouped relations, no percentages", async () => {
    render(<ChangesView snapshot={snapshot()} changeSet={changeSet} loading={false} error={null} />);

    // Entity rows are keyed by entity_key (identity, never display id alone).
    expect(document.querySelector('[data-entity-key="assignment:assignments/EXP-005.yaml"]')).toBeTruthy();
    expect(document.querySelector('[data-entity-key="WS-009"]')).toBeTruthy();

    // Current vs previous revision line.
    expect(screen.getByText("current vs previous meaningful revision")).toBeTruthy();

    // Field changes show previous → current.
    expect(screen.getAllByText("proposed").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("accepted").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("changed").length).toBeGreaterThanOrEqual(1);

    // Relations grouped added vs removed — never merged.
    expect(screen.getByText("Added relations · 1")).toBeTruthy();
    expect(screen.getByText("Removed relations · 1")).toBeTruthy();

    // Observed status trail.
    expect(screen.getByText("observed states only")).toBeTruthy();

    // No synthetic percentages anywhere.
    expect(screen.queryByText(/%/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/%\s*$/);

    // Factual count line only.
    expect(screen.getByText("2 entities changed across 2 kinds")).toBeTruthy();
  });

  it("renders an Add to context button per row wired to the context buffer", async () => {
    const { useProgrammeContext } = await import("../../../../../src/dashboard/pages/console/programme/context-buffer.ts");
    const { act } = await import("@testing-library/react");
    const before = useProgrammeContext.getState().entries.length;

    render(<ChangesView snapshot={snapshot()} changeSet={changeSet} loading={false} error={null} />);

    const buttons = screen.getAllByRole("button", { name: "Add to context" });
    expect(buttons).toHaveLength(2);

    await act(async () => {
      buttons[0].click();
    });

    const entries = useProgrammeContext.getState().entries;
    expect(entries.length).toBe(before + 1);
    expect(entries[0].entity_key).toBe("assignment:assignments/EXP-005.yaml");
    expect(entries[0].source_view).toBe("diff");
    expect(entries[0].path).toBe("assignments/EXP-005.yaml");
  });

  it("lazily fetches FILE-level revision history on expand and matches explicit SHA filter client-side", async () => {
    render(<ChangesView snapshot={snapshot()} changeSet={changeSet} loading={false} error={null} />);

    // Revision fetch is lazy — not called before expand.
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(screen.queryByText("Loading revisions…")).toBeNull();

    const { act } = await import("@testing-library/react");
    const toggle = screen.getAllByText(/Revisions — FILE-level revision history for/)[0];
    await act(async () => { toggle.click(); });

    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/programme/revisions?path=assignments%2FEXP-005.yaml");
    await vi.waitFor(() => expect(screen.getByText("accept EXP-005")).toBeTruthy());
    expect(screen.getAllByText(/current vs previous/).length).toBeGreaterThanOrEqual(1);

    // Explicit SHA filter matches client-side on status trail shas.
    fireEvent.click(screen.getByRole("button", { name: "SHA" }));
    const input = screen.getByLabelText("SHA filter");
    fireEvent.change(input, { target: { value: "aaaa" } });

    await vi.waitFor(() => expect(screen.queryByText(/No entities match/)).toBeNull());
    expect(document.querySelector('[data-entity-key="assignment:assignments/EXP-005.yaml"]')).toBeTruthy();

    // A non-matching prefix shows the honest no-match message.
    fireEvent.change(input, { target: { value: "zzzz" } });
    await vi.waitFor(() => expect(screen.getByText("No entities match zzzz")).toBeTruthy());
  });
});
