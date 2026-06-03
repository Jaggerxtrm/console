/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../../../src/dashboard/hooks/useRepoTree.ts", () => ({ useRepoTree: () => undefined }));
vi.mock("../../../../src/dashboard/hooks/useGithubActivity.ts", () => ({ useGithubActivity: () => undefined }));
vi.mock("../../../../src/dashboard/components/github/GithubPanel.tsx", () => ({ GithubPanel: () => <div data-testid="github-panel" /> }));
vi.mock("../../../../src/dashboard/components/shell/Sidebar.tsx", () => ({ Sidebar: () => <div data-testid="sidebar" /> }));
vi.mock("../../../../src/dashboard/components/shell/MainPane.tsx", () => ({ MainPane: () => <div data-testid="main-pane" /> }));
vi.mock("../../../../src/dashboard/pages/console/BeadSideDrawer.tsx", () => ({ BeadSideDrawer: () => <div data-testid="drawer" /> }));

import { App } from "../../../../src/dashboard/App.tsx";
import { TopBar } from "../../../../src/dashboard/components/shell/TopBar.tsx";
import { useShellStore } from "../../../../src/dashboard/stores/shell.ts";

function storage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => map.set(key, value),
    removeItem: (key: string) => map.delete(key),
    clear: () => map.clear(),
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("localStorage", storage());
  useShellStore.setState({ selection: { surface: "github", tab: "home", repo: null } as never });
  window.history.pushState({}, "", "/gitboard/");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Console IA restructure", () => {
  it("renders 2 surfaces and 6 console tabs", () => {
    useShellStore.setState({ selection: { surface: "console", tab: "graph", repo: null } as never });
    render(<TopBar />);

    expect(screen.getAllByRole("tab")).toHaveLength(8);
    expect(screen.getByRole("tab", { name: "GitHub" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Console" })).toBeTruthy();
    for (const label of ["Feed", "Triage", "Memories", "Graph", "Observability", "Specialists"]) {
      expect(screen.getByRole("tab", { name: label })).toBeTruthy();
    }
  });

  it("maps legacy /gitboard/beads routes to Console tabs", () => {
    window.history.pushState({}, "", "/gitboard/beads/triage");
    render(<App />);
    expect(useShellStore.getState().selection.surface).toBe("console");
    expect(useShellStore.getState().selection.tab).toBe("triage");
  });

  it("keeps GitHub selected after using the shell surface switch", () => {
    useShellStore.setState({ selection: { surface: "console", tab: "specialists", repo: null } as never });
    render(<App />);

    fireEvent.click(screen.getByRole("tab", { name: "GitHub" }));

    expect(useShellStore.getState().selection.surface).toBe("github");
    expect(useShellStore.getState().selection.tab).toBe("activity");
  });

  it("migrates persisted beads surface to console feed", async () => {
    localStorage.setItem("forge-5w9:selection", JSON.stringify({ surface: "beads", tab: "memories", repo: "gitboard" }));
    const { useShellStore: reloadedStore } = await import("../../../../src/dashboard/stores/shell.ts");
    const { App: RehydratedApp } = await import("../../../../src/dashboard/App.tsx");
    render(<RehydratedApp />);
    expect(reloadedStore.getState().selection.surface).toBe("console");
    expect(reloadedStore.getState().selection.tab).toBe("feed");
  });
});
