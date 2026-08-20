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

beforeEach(async () => {
  const { useProgrammeContext } = await import("../../../../../src/dashboard/pages/console/programme/context-buffer.ts");
  window.sessionStorage.clear();
  useProgrammeContext.setState({ entries: [], groups: [], density: "standard" });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/programme/revisions?")) return fetchOk(revisionHistory);
    if (url.startsWith("/api/programme/compare?")) return fetchOk(changeSet);
    throw new Error(`unexpected fetch ${url}`);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChangesView", () => {
  it("renders collision-safe entity changes for the browser last-visit baseline with no synthetic percentages", () => {
    render(<ChangesView snapshot={snapshot()} changeSet={changeSet} loading={false} error={null} />);

    expect(document.querySelector('[data-entity-key="assignment:assignments/EXP-005.yaml"]')).toBeTruthy();
    expect(document.querySelector('[data-entity-key="WS-009"]')).toBeTruthy();

    expect(screen.getByText("browser last visit")).toBeTruthy();
    expect(screen.getByText("aaaa1111 → bbbb2222")).toBeTruthy();

    expect(screen.getAllByText("proposed").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("accepted").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("changed").length).toBeGreaterThanOrEqual(1);

    expect(screen.getByText("Added relations · 1")).toBeTruthy();
    expect(screen.getByText("Removed relations · 1")).toBeTruthy();
    expect(screen.getByText("observed states only")).toBeTruthy();

    expect(screen.queryByText(/%/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/%\s*$/);
    expect(screen.getByText("2 entities changed across 2 kinds · 2 relation changes")).toBeTruthy();
  });

  it("adds the exact ChangeSet to Context rather than copying only the node", async () => {
    const { useProgrammeContext } = await import("../../../../../src/dashboard/pages/console/programme/context-buffer.ts");
    const { act } = await import("@testing-library/react");

    render(<ChangesView snapshot={snapshot()} changeSet={changeSet} loading={false} error={null} />);

    const buttons = screen.getAllByRole("button", { name: "Add change to context" });
    expect(buttons).toHaveLength(2);

    await act(async () => {
      buttons[0].click();
    });

    const entries = useProgrammeContext.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].entity_key).toBe("assignment:assignments/EXP-005.yaml");
    expect(entries[0].source_view).toBe("diff");
    expect(entries[0].path).toBe("assignments/EXP-005.yaml");
    expect(entries[0].change?.entity_key).toBe("assignment:assignments/EXP-005.yaml");
    expect(entries[0].change?.field_changes).toContainEqual({
      field: "status",
      kind: "changed",
      previous: "proposed",
      current: "accepted",
    });
    expect(useProgrammeContext.getState().groups.some((group) => group.kind === "diff_selection")).toBe(true);
  });

  it("lazily fetches source-file history and uses /compare for an explicit SHA baseline", async () => {
    render(<ChangesView snapshot={snapshot()} changeSet={changeSet} loading={false} error={null} />);

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(screen.queryByText("Loading source-file commits…")).toBeNull();

    const { act } = await import("@testing-library/react");
    const toggle = screen.getAllByText(/Source-file history/)[0];
    await act(async () => { toggle.click(); });

    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      "/api/programme/revisions?path=assignments%2FEXP-005.yaml&entity=assignment%3Aassignments%2FEXP-005.yaml",
    );
    await vi.waitFor(() => expect(screen.getByText("accept EXP-005")).toBeTruthy());
    expect(screen.getByText(/These are commits touching the source file/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "SHA" }));
    const input = screen.getByLabelText("Baseline commit SHA");
    fireEvent.change(input, { target: { value: "aaaa1111" } });
    await act(async () => {
      screen.getByRole("button", { name: "Compare" }).click();
    });

    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe("/api/programme/compare?from=aaaa1111&to=aaaa");
    await vi.waitFor(() => expect(screen.getByText("explicit aaaa1111")).toBeTruthy());
    expect(screen.getByText("aaaa1111 → bbbb2222")).toBeTruthy();
  });
});
