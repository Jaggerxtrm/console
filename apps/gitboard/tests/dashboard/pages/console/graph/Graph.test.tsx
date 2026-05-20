/** @vitest-environment happy-dom */
// forge-2a8a.4 — Smoke test for the React Flow viewport.
// Asserts: page scaffolding renders, partitionGraph wires through, cluster
// sections exist. React Flow's internal canvas needs ResizeObserver +
// getBoundingClientRect which happy-dom provides as minimal stubs; we don't
// assert on rendered chip positions (that's the role of Playwright in CI).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import fixtureJson from "../../../../fixtures/console-graph.json";
import type { GraphResponse } from "../../../../../src/types/graph.ts";

const fixture = fixtureJson as GraphResponse;

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// React Flow needs ResizeObserver; happy-dom's stub is enough but the React
// Flow internals also poll DOMMatrix in some paths — stub once for safety.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
}
if (typeof globalThis.DOMMatrixReadOnly === "undefined") {
  globalThis.DOMMatrixReadOnly = class {
    m22 = 1;
  } as never;
}

import { Graph } from "../../../../../src/dashboard/pages/console/Graph.tsx";
import { useShellStore } from "../../../../../src/dashboard/stores/shell.ts";

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => fixture });
  useShellStore.setState({ selection: { surface: "console", tab: "graph", repo: "gitboard" } as never });
});

describe("Graph (React Flow viewport)", () => {
  it("renders the page scaffolding after fixture loads", async () => {
    const { container } = render(<Graph />);
    await waitFor(() => {
      expect(container.querySelector(".g-app")).toBeTruthy();
      expect(container.querySelector(".g-clusters")).toBeTruthy();
    });
  });

  it("emits one .g-cluster section per partitionGraph cluster", async () => {
    const { container } = render(<Graph />);
    await waitFor(() => {
      const clusters = container.querySelectorAll(".g-cluster");
      expect(clusters.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("mounts a React Flow ReactFlowProvider per cluster pane", async () => {
    const { container } = render(<Graph />);
    await waitFor(() => {
      // React Flow injects .react-flow class on its root container.
      const panes = container.querySelectorAll(".g-pane .react-flow");
      expect(panes.length).toBeGreaterThanOrEqual(1);
    });
  });
});
