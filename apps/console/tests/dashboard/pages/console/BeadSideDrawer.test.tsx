/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useBeadSideDrawer } from "../../../../src/dashboard/hooks/useBeadSideDrawer.ts";
import { useShellStore } from "../../../../src/dashboard/stores/shell.ts";
import type { BeadIssue } from "../../../../src/types/beads.ts";

vi.mock("../../../../src/dashboard/hooks/useSpecialistOwnership.ts", () => ({ useSpecialistOwnership: () => ({ role: "executor", state: "running", repoSlug: "gitboard", jobId: "job-1" }) }));
vi.mock("../../../../src/dashboard/hooks/useSpecialistHistory.ts", () => ({ useSpecialistHistory: () => ({ count: 2, jobs: [], loading: false, error: null }) }));
vi.mock("../../../../src/dashboard/lib/beads.ts", () => ({ substrateApi: { getIssue: vi.fn(async () => ({ ...issue("forge-b2", "Beta"), dependents: [{ id: "forge-b1", title: "Alpha", status: "open", dependency_type: "related" }], source: "dolt", sourceHealth: [] })) } }));
vi.mock("../../../../src/dashboard/components/beads/IssueFeed.tsx", () => ({ IssueDossier: () => <div data-testid="issue-dossier" /> }));
vi.mock("../../../../src/dashboard/components/specialists/BeadActivityPane.tsx", () => ({ BeadActivityPane: ({ beadId }: { beadId: string }) => <div data-testid="activity-pane">{beadId}</div> }));

import { BeadSideDrawer } from "../../../../src/dashboard/pages/console/BeadSideDrawer.tsx";

beforeEach(() => {
  useBeadSideDrawer.setState({
    beadId: null,
    jobId: null,
    projectId: "gitboard",
    issueById: new Map([["forge-b1", issue("forge-b1", "Alpha")], ["forge-b2", issue("forge-b2", "Beta")]]),
    fallbackIssue: null,
    memories: [{ id: "mem-1", content: "forge-b2 memory", type: "learned", tags: ["x"], created_at: "2026-01-01T00:00:00.000Z", issue_id: "forge-b2", project_id: "gitboard" }],
    tab: "overview",
    backStack: [],
  });
  useShellStore.setState({ selection: { surface: "console", tab: "graph", repo: "gitboard" } as never });
});

describe("Console BeadSideDrawer", () => {
  it("renders inspector tabs and preserves back navigation across lineage clicks", async () => {
    act(() => useBeadSideDrawer.getState().open("forge-b2"));
    render(<BeadSideDrawer />);

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /overview/i })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("tab", { name: /lineage/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /forge-b1/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /forge-b1/i }));

    expect(useBeadSideDrawer.getState().beadId).toBe("forge-b1");
    expect(useBeadSideDrawer.getState().backStack).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /back to previous bead/i }));
    expect(useBeadSideDrawer.getState().beadId).toBe("forge-b2");
  });

  it("keeps activity and memories as sibling evidence surfaces", async () => {
    act(() => useBeadSideDrawer.getState().open({ beadId: "forge-b2", jobId: "job-1" }));
    render(<BeadSideDrawer />);

    fireEvent.click(await screen.findByRole("tab", { name: /activity/i }));
    expect(screen.getByTestId("activity-pane")).toHaveTextContent("forge-b2");

    fireEvent.click(screen.getByRole("tab", { name: /memories/i }));
    expect(screen.getByText("forge-b2 memory")).toBeInTheDocument();
  });

  it("open in feed preserves shell routing", async () => {
    vi.stubGlobal("CSS", { escape: (value: string) => value } as typeof CSS);
    act(() => useBeadSideDrawer.getState().open("forge-b2"));
    render(<BeadSideDrawer />);

    fireEvent.click(await screen.findByRole("button", { name: "Open in Feed" }));

    expect(useShellStore.getState().selection.tab).toBe("feed");
    expect(useBeadSideDrawer.getState().beadId).toBeNull();
  });
});

function issue(id: string, title: string): BeadIssue {
  return {
    id,
    title,
    description: null,
    status: "open",
    priority: 1,
    issue_type: "task",
    owner: null,
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: null,
    updated_at: "2026-01-02T00:00:00.000Z",
    project_id: "gitboard",
    dependencies: [],
    related_ids: [],
    labels: [],
  };
}
