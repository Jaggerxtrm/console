/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IssueFeed } from "../../../../src/dashboard/components/beads/IssueFeed.tsx";
import { useShellStore } from "../../../../src/dashboard/stores/shell.ts";
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
  substrateApi: { listInteractions: vi.fn(async () => []) },
}));

vi.mock("../../../../src/dashboard/lib/client-log.ts", () => ({
  logClientEvent: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useShellStore.setState({ sidebar: { open: false, beadId: null, jobId: null, width: 480 } });
});

describe("IssueFeed specialist chip wiring", () => {
  it("opens the right sidebar and records swap telemetry from the feed chip", () => {
    useShellStore.getState().openSidebar({ beadId: "forge-old", jobId: "job-old" });
    render(
      <IssueFeed
        issues={[issue("forge-1")]}
        selectedIssueId={null}
        selectedIssueDetail={null}
        loadingDetailId={null}
        onIssueSelect={vi.fn()}
        onIssueOpen={vi.fn()}
        projectId="gitboard"
        specialistByIssueId={new Map([["forge-1", { role: "executor", state: "running", jobId: "job-feed", repoSlug: "gitboard" }]])}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: /executor:job-fe/i }).at(-1)!);

    expect(useShellStore.getState().sidebar).toMatchObject({ open: true, beadId: "forge-1", jobId: "job-feed" });
    expect(logClientEvent).toHaveBeenCalledWith("chip.click", { source: "feed_chip", beadId: "forge-1", jobId: "job-feed" });
    expect(logClientEvent).toHaveBeenCalledWith("chip.sidebar.dispatched", expect.objectContaining({
      source: "feed_chip",
      beadId: "forge-1",
      swap: true,
      prevSidebar: { beadId: "forge-old", jobId: "job-old" },
    }));
  });
});

describe("IssueFeed dependency history", () => {
  it("auto-expands closed history when only closed issues have dependency metadata", async () => {
    render(
      <IssueFeed
        issues={[issue("unitAI-open")]}
        closedIssues={[{
          ...issue("unitAI-closed"),
          title: "Closed source",
          status: "closed",
          dependencies: [{ id: "unitAI-target", title: "Closed target", status: "closed", dependency_type: "blocks" }],
        }]}
        selectedIssueId={null}
        selectedIssueDetail={null}
        loadingDetailId={null}
        onIssueSelect={vi.fn()}
        onIssueOpen={vi.fn()}
        projectId="specialists"
      />,
    );

    expect(await screen.findByText("Closed source")).toBeInTheDocument();
    expect(screen.getByText("unitAI-target")).toBeInTheDocument();
    expect(logClientEvent).toHaveBeenCalledWith("feed.closed_history.auto_expanded", expect.objectContaining({ dependencyCount: 1 }));
  });
});

function issue(id: string): BeadIssue {
  return {
    id,
    title: "Specialist chip issue",
    description: null,
    status: "open",
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
