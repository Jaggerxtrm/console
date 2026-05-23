/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const useGraphDataMock = vi.fn();
vi.mock("../../../../../src/dashboard/hooks/useGraphData.ts", () => ({
  useGraphData: () => useGraphDataMock(),
}));

import { Graph } from "../../../../../src/dashboard/pages/console/Graph.tsx";
import { useShellStore } from "../../../../../src/dashboard/stores/shell.ts";

beforeEach(() => {
  useShellStore.setState({ selection: { surface: "console", tab: "graph", repo: "gitboard" } as never });
});

describe("Graph empty state", () => {
  it("shows loading for stale empty graph", () => {
    useGraphDataMock.mockReturnValue({ loading: false, error: null, data: { freshness: "stale", nodes: [], edges: [], specialists: [] } });
    const { getByText } = render(<Graph />);
    expect(getByText("Loading project graph… Background refresh in progress.")).toBeTruthy();
  });

  it("shows loading when freshness missing on empty graph", () => {
    useGraphDataMock.mockReturnValue({ loading: false, error: null, data: { nodes: [], edges: [], specialists: [] } });
    const { getByText, queryByText } = render(<Graph />);
    expect(getByText("Loading project graph… Background refresh in progress.")).toBeTruthy();
    expect(queryByText("No beads in this project")).toBeNull();
  });

  it("shows empty for fresh empty graph", () => {
    useGraphDataMock.mockReturnValue({ loading: false, error: null, data: { freshness: "fresh", nodes: [], edges: [], specialists: [] } });
    const { getByText } = render(<Graph />);
    expect(getByText("No beads in this project")).toBeTruthy();
  });

  it("shows degraded retry for failed graph refresh", () => {
    useGraphDataMock.mockReturnValue({ loading: false, error: null, data: { freshness: "degraded", nodes: [], edges: [], specialists: [] }, reload: vi.fn() });
    const { getByText } = render(<Graph />);
    expect(getByText("Graph data unavailable — last refresh failed")).toBeTruthy();
  });

  it("surfaces graph source-health messages for selection failures", () => {
    useGraphDataMock.mockReturnValue({ loading: false, error: null, data: { freshness: "degraded", source_health: { source: "graph", status: "degraded", checked_at: "2026-01-01T00:00:00.000Z", message: "Graph project_id is missing; select a beads project." }, nodes: [], edges: [], specialists: [] }, reload: vi.fn() });
    const { getByText } = render(<Graph />);
    expect(getByText("Graph project_id is missing; select a beads project.")).toBeTruthy();
  });
});
