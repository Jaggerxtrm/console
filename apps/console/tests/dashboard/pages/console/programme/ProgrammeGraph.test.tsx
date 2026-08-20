/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { ProgrammeChangeSet, ProgrammeGraph, ProgrammeSnapshot } from "../../../../../src/types/programme.ts";

const mockOpen = vi.fn();
const mockAddNode = vi.fn();
const mockAddSelection = vi.fn();

vi.mock("../../../../../src/dashboard/pages/console/programme/programme-drawer.ts", () => ({
  useProgrammeDrawer: (selector: (state: { open: (id: string) => void; nodeId: string | null }) => unknown) => selector({ open: mockOpen, nodeId: null }),
}));

vi.mock("../../../../../src/dashboard/pages/console/programme/context-buffer.ts", () => ({
  useProgrammeContext: (selector: (state: { addNode: (...args: unknown[]) => void; addSelection: (...args: unknown[]) => void }) => unknown) => selector({ addNode: mockAddNode, addSelection: mockAddSelection }),
}));

let rfEdges: unknown[] = [];
let rfNodes: unknown[] = [];
let rfOnNodeClick: ((_event: unknown, node: { id: string; data: unknown }) => void) | null = null;

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  const MockFlow = (props: { nodes: unknown[]; edges: unknown[]; onNodeClick?: (_event: unknown, node: { id: string; data: unknown }) => void; children?: React.ReactNode }) => {
    rfEdges = props.edges ?? [];
    rfNodes = props.nodes ?? [];
    rfOnNodeClick = props.onNodeClick ?? null;
    return <div data-testid="mock-react-flow">{rfNodes.map((raw) => {
      const node = raw as { id: string; data: unknown };
      return <button key={node.id} data-testid={`node-${node.id}`} onClick={(event) => rfOnNodeClick?.(event, node)} />;
    })}</div>;
  };
  return {
    ...actual,
    ReactFlow: MockFlow,
    ReactFlowProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    Background: () => null,
    Controls: () => null,
  };
});

import { ProgrammeGraphView } from "../../../../../src/dashboard/pages/console/programme/ProgrammeGraph.tsx";
import { useProgrammeChangeStore } from "../../../../../src/dashboard/pages/console/programme/useProgrammeChanges.ts";

const graph: ProgrammeGraph = {
  nodes: [
    { id: "WS-001", kind: "workstream", title: "Programme foundation", status: "ACTIVE" },
    { id: "OPS-001", kind: "assignment", title: "Core ops", status: "IN_PROGRESS" },
    { id: "EXP-002", kind: "assignment", title: "Experiment two", status: "PROPOSED" },
    { id: "RES-001", kind: "research", title: "Research one", status: "DRAFT" },
    { id: "ISSUE-999", kind: "jira", title: "Disconnected issue", status: "UNKNOWN" },
  ],
  edges: [
    { source: "WS-001", target: "OPS-001", relation: "assigns", field: "workstream", strength: "strong" },
    { source: "OPS-001", target: "EXP-002", relation: "references", field: "refs", strength: "weak" },
    { source: "EXP-002", target: "RES-001", relation: "contains", field: "workstream", strength: "strong" },
  ],
  metadata_fields: [],
  identity_collisions: [],
};

const snapshot: ProgrammeSnapshot = {
  schema_version: 3,
  generated_at: "2026-01-01T00:00:00.000Z",
  programme: { repository: "mercuryintelligence/program", branch: "master", sha: "abc123def", short_sha: "abc123d" },
  now: { title: "now", path: "NOW.md" },
  business: {},
  workstreams: [], assignments: [], research: [], decisions: [], proposals: [], agents: [], jira_refs: [], operator_input_refs: [], activity: [],
  graph,
  identity_collisions: [], evidence_boundary: {}, state_records: [], journals: [], publication_facts: [],
  state_history_semantics: { current_state_precedence: "", journal_authority: "", publication_separation: "", unsafe_nested_relationship_policy: "", suppressed_unsafe_nested_edges: 0 },
  provenance: { current: { programme_actor_registry: false, state_actor_assignment_fields: false, wrapper_publication_facts: false, xtrm_mutation_receipts: false }, rules: [], live_receipt_gate: "" },
  source_health: { source: "programme", status: "fresh", checked_at: "2026-01-01T00:00:00.000Z" },
} as ProgrammeSnapshot;

beforeEach(() => {
  rfEdges = [];
  rfNodes = [];
  rfOnNodeClick = null;
  mockOpen.mockReset();
  mockAddNode.mockReset();
  mockAddSelection.mockReset();
  useProgrammeChangeStore.setState({ changeSet: null });
  window.history.pushState({}, "", "/console/programme/graph");
});

afterEach(cleanup);

describe("ProgrammeGraphView", () => {
  it("starts in a true focused 2-hop view and keeps weak refs disabled", () => {
    render(<ProgrammeGraphView graph={graph} snapshot={snapshot} />);
    // OPS-001 is the first active assignment. In Structural mode its only
    // strong neighbor is WS-001. Weak OPS-001 -> EXP-002 does not participate.
    expect(rfNodes.map((node) => (node as { id: string }).id).sort()).toEqual(["OPS-001", "WS-001"]);
    expect(rfEdges).toHaveLength(1);
    expect((rfEdges[0] as { data: { edge: { strength: string } } }).data.edge.strength).toBe("strong");
    expect(screen.getByTestId("pg2-ctxbar").textContent).toContain("OPS-001");
    expect(screen.getByRole("button", { name: "Focused 2-hop" }).className).toContain("is-active");
  });

  it("shows the whole filtered programme only after explicit All programme", () => {
    render(<ProgrammeGraphView graph={graph} snapshot={snapshot} />);
    fireEvent.click(screen.getByRole("button", { name: "All programme" }));
    expect(rfNodes).toHaveLength(5);
    expect(rfEdges).toHaveLength(2); // weak ref still disabled
    fireEvent.click(screen.getByRole("button", { name: "All refs" }));
    expect(rfEdges).toHaveLength(3);
  });

  it("focuses by entity click and exposes context selection actions", () => {
    render(<ProgrammeGraphView graph={graph} snapshot={snapshot} />);
    fireEvent.click(screen.getByRole("button", { name: "All programme" }));
    fireEvent.click(screen.getByTestId("node-WS-001"));
    expect(screen.getByTestId("pg2-ctxbar").textContent).toContain("WS-001");
    expect(screen.getByRole("button", { name: "Add object" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add neighborhood" })).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("entity")).toBe("WS-001");
  });

  it("renders removed entities as ghost change records in Changes mode", () => {
    const set: ProgrammeChangeSet = {
      previous_sha: "aaaaaaa1",
      current_sha: "abc123def",
      generated_at: "2026-01-01T00:00:00Z",
      relation_count: 0,
      entities: [{
        entity_key: "EXP-REMOVED",
        display_id: "EXP-REMOVED",
        kind: "assignment",
        title: "Removed assignment",
        path: "assignments/EXP-REMOVED.yaml",
        field_changes: [{ field: "status", kind: "removed", previous: "READY" }],
        relation_changes: [],
        status_trail: [
          { sha: "aaaaaaa1", date: "2025-12-31T00:00:00Z", status: "READY" },
          { sha: "abc123def", date: "2026-01-01T00:00:00Z", status: null },
        ],
        previous_revision_sha: "aaaaaaa1",
        current_revision_sha: "abc123def",
      }],
    };
    useProgrammeChangeStore.setState({ changeSet: set });
    render(<ProgrammeGraphView graph={graph} snapshot={snapshot} />);
    fireEvent.click(screen.getByRole("button", { name: /Changes/ }));
    expect(rfNodes.some((node) => (node as { id: string }).id === "EXP-REMOVED")).toBe(true);
    const removed = rfNodes.find((node) => (node as { id: string }).id === "EXP-REMOVED") as { data: { changeKind: string } };
    expect(removed.data.changeKind).toBe("removed");
  });
});
