/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NodeChip } from "../../../../src/dashboard/pages/console/Graph.tsx";
import { useBeadSideDrawer } from "../../../../src/dashboard/hooks/useBeadSideDrawer.ts";
import type { GraphNode } from "../../../../src/types/graph.ts";

vi.mock("../../../../src/dashboard/lib/client-log.ts", () => ({ logClientEvent: vi.fn() }));

beforeEach(() => {
  useBeadSideDrawer.setState({
    beadId: null,
    jobId: null,
    projectId: "gitboard",
    issueById: new Map(),
    fallbackIssue: null,
    memories: [],
    tab: "overview",
    backStack: [],
  });
});

describe("Graph NodeChip", () => {
  it("opens the bead drawer from a graph chip", () => {
    render(<NodeChip node={node("forge-graph", "Graph drawer target")} specialist={null} />);

    fireEvent.click(screen.getByRole("button", { name: /forge-graph/i }));

    expect(useBeadSideDrawer.getState().beadId).toBe("forge-graph");
    expect(useBeadSideDrawer.getState().fallbackIssue).toEqual(expect.objectContaining({ id: "forge-graph", title: "Graph drawer target" }));
  });
});

function node(id: string, title: string): GraphNode {
  return {
    id,
    title,
    type: "task",
    priority: 2,
    status: "open",
    assignee: null,
    closed_at: null,
    superseded_by: null,
  };
}
