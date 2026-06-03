/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IssueFeed } from "../../../../src/dashboard/components/beads/IssueFeed.tsx";
import { logClientEvent } from "../../../../src/dashboard/lib/client-log.ts";
import type { BeadIssue } from "../../../../src/types/beads.ts";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, getItemKey }: { count: number; getItemKey: (index: number) => string }) => ({
    getTotalSize: () => count * 52,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: getItemKey(index), start: index * 52 })),
    measureElement: vi.fn(),
  }),
}));

vi.mock("../../../../src/dashboard/hooks/useSpecialistHistory.ts", () => ({
  useSpecialistHistory: () => ({ count: 0, jobs: [] }),
}));

vi.mock("../../../../src/dashboard/lib/beads.ts", () => ({
  substrateApi: {
    listInteractions: vi.fn(async () => []),
  },
}));

vi.mock("../../../../src/dashboard/lib/client-log.ts", () => ({
  logClientEvent: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("IssueFeed search", () => {
  it("filters by id prefix and clears from the inline affordance", () => {
    renderFeed();

    const input = screen.getByRole("searchbox", { name: "Search beads in this project" });
    fireEvent.change(input, { target: { value: "forge-58" } });

    expect(screen.getByText("Memory leak")).toBeInTheDocument();
    expect(screen.getByText("Cache leak")).toBeInTheDocument();
    expect(screen.queryByText("Deploy polish")).not.toBeInTheDocument();
    expect(logClientEvent).toHaveBeenCalledWith("feed.search.query_changed", expect.objectContaining({ queryLength: 8, prefixMatchCount: 2, totalMatches: 2 }));

    fireEvent.click(screen.getByRole("button", { name: "Clear bead search" }));

    expect(input).toHaveValue("");
    expect(screen.getByText("Deploy polish")).toBeInTheDocument();
    expect(logClientEvent).toHaveBeenCalledWith("feed.search.cleared", { source: "x" });
  });

  it("focuses with Cmd/Ctrl+K and clears with Escape", () => {
    renderFeed();

    const input = screen.getByRole("searchbox", { name: "Search beads in this project" });
    fireEvent.keyDown(window, { key: "k", metaKey: true });

    expect(document.activeElement).toBe(input);
    expect(logClientEvent).toHaveBeenCalledWith("feed.search.focused", { source: "hotkey" });

    fireEvent.change(input, { target: { value: "no-match" } });
    expect(logClientEvent).toHaveBeenCalledWith("feed.search.empty_result", { query: "no-match" });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(input).toHaveValue("");
    expect(document.activeElement).not.toBe(input);
    expect(logClientEvent).toHaveBeenCalledWith("feed.search.cleared", { source: "esc" });
  });
});

function renderFeed() {
  const issues = [
    issue("forge-58ek", "Memory leak", "open"),
    issue("forge-58zz", "Cache leak", "in_progress"),
    issue("forge-abcd", "Deploy polish", "open"),
  ];

  return render(
    <IssueFeed
      issues={issues}
      closedIssues={[issue("forge-done", "Closed leak", "closed")]}
      selectedIssueId={null}
      selectedIssueDetail={null}
      loadingDetailId={null}
      onIssueSelect={vi.fn()}
      onIssueOpen={vi.fn()}
      projectId="gitboard"
    />,
  );
}

function issue(id: string, title: string, status: string): BeadIssue {
  return {
    id,
    title,
    description: null,
    status,
    priority: 1,
    issue_type: "task",
    owner: null,
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: null,
    updated_at: "2026-01-01T00:00:00.000Z",
    project_id: "gitboard",
    dependencies: [],
    related_ids: [],
    labels: [],
  };
}
