/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import fixtureJson from "../../../../fixtures/console-graph.json";
import type { GraphResponse } from "../../../../../src/types/graph.ts";

const fixture = fixtureJson as GraphResponse;
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { Graph } from "../../../../../src/dashboard/pages/console/Graph.tsx";
import { useShellStore } from "../../../../../src/dashboard/stores/shell.ts";
import { layoutGraph } from "../../../../../src/dashboard/pages/console/graph/layout.ts";

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => fixture });
  useShellStore.setState({ selection: { surface: "console", tab: "graph", repo: "gitboard" } as never });
});

describe("Graph page", () => {
  it("renders deterministic layout from fixture", () => {
    const first = layoutGraph(fixture.nodes, fixture.edges);
    const second = layoutGraph(fixture.nodes, fixture.edges);
    expect(second.nodes.map((node) => [node.id, node.x, node.y, node.layer, node.order])).toEqual(first.nodes.map((node) => [node.id, node.x, node.y, node.layer, node.order]));
  });

  it("renders edge types, pulse, hover dim, and click emit", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    render(<Graph />);

    expect(await screen.findByText("forge-b2")).toBeTruthy();
    const nodes = document.querySelectorAll(".graph-node");
    expect(nodes.length).toBeGreaterThanOrEqual(4);
    expect(document.querySelectorAll(".graph-node-pulse").length).toBe(1);

    const group = document.querySelectorAll(".graph-node")[1] as SVGGElement;
    fireEvent.mouseEnter(group);
    expect(group.classList.contains("is-dimmed")).toBe(false);
    expect(document.querySelectorAll(".graph-node.is-dimmed").length).toBeGreaterThan(0);

    fireEvent.click(group);
    expect(log).toHaveBeenCalledWith("forge-b2");
    log.mockRestore();
  });

  it("resets transform and empty states when no repo", () => {
    document.body.innerHTML = "";
    useShellStore.setState({ selection: { surface: "console", tab: "graph", repo: null } as never });
    render(<Graph />);
    expect(screen.getAllByText("No beads in this project").length).toBe(1);
  });
});
