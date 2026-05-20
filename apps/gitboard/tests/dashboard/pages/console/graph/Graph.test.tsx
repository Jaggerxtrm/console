/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import fixtureJson from "../../../../fixtures/console-graph.json";
import type { GraphResponse } from "../../../../../src/types/graph.ts";

const fixture = fixtureJson as GraphResponse;
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { GraphSvg } from "../../../../../src/dashboard/pages/console/graph/GraphSvg.tsx";
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
    const layout = layoutGraph(fixture.nodes, fixture.edges);
    const onNodeClick = vi.fn();
    render(<svg><GraphSvg nodes={layout.nodes} edges={layout.edges} specialists={new Set(["forge-b2"])} onNodeClick={onNodeClick} /></svg>);

    expect(document.querySelectorAll(".graph-node").length).toBeGreaterThanOrEqual(4);
    expect(document.querySelectorAll(".graph-node-pulse").length).toBe(1);

    const beforeHover = document.querySelectorAll(".graph-node.is-dimmed").length;
    const group = [...document.querySelectorAll(".graph-node")].find((node) => node.textContent?.includes("forge-b2")) as SVGGElement;
    fireEvent.mouseEnter(group);
    expect(document.querySelectorAll(".graph-node.is-dimmed").length).toBeGreaterThan(beforeHover);
    fireEvent.mouseLeave(group);
    expect(document.querySelectorAll(".graph-node.is-dimmed").length).toBe(beforeHover);

    fireEvent.click(group);
    expect(onNodeClick).toHaveBeenCalledWith("forge-b2");
  });

});
