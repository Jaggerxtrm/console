/** @vitest-environment happy-dom */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDocumentTitle } from "../../../src/dashboard/hooks/useDocumentTitle.ts";
import { logClientEvent } from "../../../src/dashboard/lib/client-log.ts";
import { useShellStore } from "../../../src/dashboard/stores/shell.ts";

vi.mock("../../../src/dashboard/lib/client-log.ts", () => ({
  logClientEvent: vi.fn(),
}));

function Harness() {
  useDocumentTitle();
  return null;
}

beforeEach(() => {
  localStorage.clear();
  document.title = "console";
  vi.mocked(logClientEvent).mockClear();
  act(() => {
    useShellStore.setState({
      repos: [],
      selection: { surface: "console", tab: "feed", repo: null },
      sidebarCollapsed: false,
    });
  });
});

afterEach(() => cleanup());

describe("useDocumentTitle", () => {
  it("uses console without a selected project", () => {
    render(<Harness />);

    expect(document.title).toBe("console");
    expect(logClientEvent).not.toHaveBeenCalled();
  });

  it("sets project title and ignores unrelated store mutations", () => {
    render(<Harness />);

    act(() => {
      useShellStore.getState().setRepos([{
        fullName: "Jaggerxtrm/gitboard",
        displayName: "gitboard",
        lastActivityAt: null,
        openBeadsCount: 0,
        githubStats: { openPRs: 0, commitsToday: 0, openIssues: 0, releases: 0 },
        beadsStats: { open: 0, inProgress: 0, blocked: 0, epics: 0 },
        beadsSource: { label: "dolt", title: "Beads reading from Dolt", healthy: true },
        hasGithub: true,
        hasBeads: true,
      }]);
      useShellStore.getState().setRepo("Jaggerxtrm/gitboard");
    });

    expect(document.title).toBe("gitboard · console");
    expect(logClientEvent).toHaveBeenCalledWith("documentTitle.changed", { from: "console", to: "gitboard · console", source: "project_select" });

    vi.mocked(logClientEvent).mockClear();
    act(() => useShellStore.getState().setDrawerOpen(true));

    expect(document.title).toBe("gitboard · console");
    expect(logClientEvent).not.toHaveBeenCalled();
  });
});
