/** @vitest-environment happy-dom */
// EXP-020 Graph V2 smoke tests: default weak refs hidden, focus context bar,
// explicit All programme toggle. React Flow is mocked at the module level so
// the test asserts on the graph we hand it (nodes/edges props + onNodeClick)
// instead of its happy-dom layout internals.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { ProgrammeGraph, ProgrammeSnapshot } from "../../../../../src/types/programme.ts";

const mockOpen = vi.fn();
const mockAddNode = vi.fn();

vi.mock("../../../../../src/dashboard/pages/console/programme/programme-drawer.ts", () => ({
  useProgrammeDrawer: (selector: (s: { open: (id: string) => void; nodeId: string | null }) => unknown) =>
    selector({ open: mockOpen, nodeId: null }),
}));

vi.mock("../../../../../src/dashboard/pages/console/programme/context-buffer.ts", () => ({
  useProgrammeContext: (selector: (s: { addNode: (...args: unknown[]) => void }) => unknown) =>
    selector({ addNode: mockAddNode }),
}));

// Mock React Flow: render a plain div that records the props the component
// passes, and re-emits node clicks. This keeps the test on our graph data.
let rfEdges: unknown[] = [];
let rfNodes: unknown[] = [];
let rfOnNodeClick: ((_e: unknown, node: { id: string; data: unknown }) => void) | null = null;

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  const mockReactFlow = (props: {
    nodes: unknown[];
    edges: unknown[];
    onNodeClick?: (_e: unknown, node: { id: string; data: unknown }) => void;
    children?: React.ReactNode;
  }) => {
    rfEdges = props.edges ?? [];
    rfNodes = props.nodes ?? [];
    rfOnNodeClick = props.onNodeClick ?? null;
    return (
      <div data-testid="mock-react-flow">
        {rfNodes.map((n) => {
          const node = n as { id: string };
          return <button key={node.id} data-testid={`node-${node.id}`} onClick={(e) => rfOnNodeClick?.(e, { id: node.id, data: (n as { data: unknown }).data })} />;
        })}
      </div>
    );
  };
  return {
    ...actual,
    ReactFlow: mockReactFlow,
    ReactFlowProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    Background: () => null,
    Controls: () => null,
  };
});

import { ProgrammeGraphView } from "../../../../../src/dashboard/pages/console/programme/ProgrammeGraph.tsx";

const graph: ProgrammeGraph = {
  nodes: [
    { id: "WS-001", kind: "workstream", title: "Programme foundation", status: "ACTIVE" },
    { id: "OPS-001", kind: "assignment", title: "Core ops", status: "IN_PROGRESS" },
    { id: "EXP-002", kind: "assignment", title: "Experiment two", status: "PROPOSED" },
    { id: "RES-001", kind: "research", title: "Research one", status: "DRAFT" },
  ],
  edges: [
    { source: "WS-001", target: "OPS-001", relation: "assigns", field: "workstream", strength: "strong" },
    { source: "OPS-001", target: "EXP-002", relation: "references", field: "refs", strength: "weak" },
    { source: "WS-001", target: "EXP-002", relation: "tracks", field: "refs", strength: "weak" },
    { source: "EXP-002", target: "RES-001", relation: "mentions", field: "refs", strength: "weak" },
  ],
  metadata_fields: [],
  identity_collisions: [],
};

const snapshot: ProgrammeSnapshot = {
  schema_version: 3,
  generated_at: "2026-01-01T00:00:00.000Z",
  programme: { repository: "mercuryintelligence/program", branch: "master", sha: "abc123", short_sha: "abc1234" },
  now: { title: "now", path: "state/now.md" },
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
  graph,
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
  source_health: { source: "programme", status: "fresh", checked_at: "2026-01-01T00:00:00.000Z" },
};

beforeEach(() => {
  rfEdges = [];
  rfNodes = [];
  rfOnNodeClick = null;
  mockOpen.mockReset();
  mockAddNode.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("ProgrammeGraphView (Graph V2)", () => {
  it("defaults to Structural mode: weak refs hidden, strong edge kept", () => {
    render(<ProgrammeGraphView graph={graph} snapshot={snapshot} />);
    expect(rfEdges).toHaveLength(1);
    expect(rfEdges[0]).toMatchObject({ source: "WS-001", target: "OPS-001" });
    expect((rfEdges[0] as { data: { edge: { strength: string } } }).data.edge.strength).toBe("strong");
    // Weak reference edges are not rendered in default Structural mode.
    expect(rfEdges.some((e) => (e as { data: { edge: { strength: string } } }).data.edge.strength === "weak")).toBe(false);
    expect(rfNodes).toHaveLength(4);
  });

  it("focusing a node shows the context bar with the focused id and 2-hop edges", () => {
    render(<ProgrammeGraphView graph={graph} snapshot={snapshot} />);
    fireEvent.click(screen.getByTestId("node-WS-001"));

    const bar = screen.getByTestId("pg2-ctxbar");
    expect(bar.textContent).toContain("WS-001");
    expect(bar.textContent).toContain("Open inspector");
    expect(bar.textContent).toContain("Add to context");
    expect(bar.textContent).toContain("Clear focus");

    // Focus view renders only the 2-hop neighborhood: WS-001 (0), OPS-001 /
    // EXP-002 (hop 1), RES-001 (hop 2). Edges: strong WS→OPS plus the weak
    // edge incident to the focused node (WS→EXP) as dashed derived context;
    // the other weak edges (OPS→EXP, EXP→RES) stay hidden in Structural mode
    // per requirement 7.
    expect(rfNodes.map((n) => (n as { id: string }).id).sort()).toEqual(["EXP-002", "OPS-001", "RES-001", "WS-001"]);
    expect(rfEdges.map((e) => (e as { source: string; target: string }).source + "->" + (e as { source: string; target: string }).target).sort()).toEqual(["WS-001->EXP-002", "WS-001->OPS-001"]);
  });

  it("exposes an explicit All programme toggle", () => {
    render(<ProgrammeGraphView graph={graph} snapshot={snapshot} />);
    expect(screen.getByRole("button", { name: "All programme" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Focus" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Structural" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "All refs" })).toBeTruthy();
  });
});
