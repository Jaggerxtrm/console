/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NodeChip } from "../../../../src/dashboard/pages/console/Graph.tsx";
import { useShellStore } from "../../../../src/dashboard/stores/shell.ts";
import { logClientEvent } from "../../../../src/dashboard/lib/client-log.ts";
import type { GraphNode, GraphSpecialist } from "../../../../src/types/graph.ts";

vi.mock("@xyflow/react", () => ({
  ReactFlow: () => null,
  ReactFlowProvider: ({ children }: { children: unknown }) => children,
  Background: () => null,
  Controls: () => null,
}));

vi.mock("@xyflow/react/dist/style.css", () => ({}));

vi.mock("../../../../src/dashboard/lib/client-log.ts", () => ({
  logClientEvent: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useShellStore.setState({ sidebar: { open: false, beadId: null, jobId: null, width: 480 } });
});

describe("Graph specialist chip wiring", () => {
  it("opens the sidebar from a graph node chip", () => {
    render(<NodeChip node={node()} specialist={specialist()} wide />);

    fireEvent.click(screen.getByRole("button"));

    expect(useShellStore.getState().sidebar).toMatchObject({ open: true, beadId: "forge-graph", jobId: "job-graph" });
    expect(logClientEvent).toHaveBeenCalledWith("chip.click", { source: "graph_node", beadId: "forge-graph", jobId: "job-graph" });
    expect(logClientEvent).toHaveBeenCalledWith("chip.sidebar.dispatched", expect.objectContaining({ source: "graph_node", beadId: "forge-graph", jobId: "job-graph", swap: false }));
  });
});

function node(): GraphNode {
  return {
    id: "forge-graph",
    title: "Graph chip",
    type: "bug",
    priority: 0,
    status: "in_progress",
    assignee: null,
    closed_at: null,
    superseded_by: null,
  };
}

function specialist(): GraphSpecialist {
  return {
    bead_id: "forge-graph",
    role: "reviewer",
    status: "running",
    job_id: "job-graph",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}
