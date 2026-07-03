/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useBeadSideDrawer } from "../../../../src/dashboard/hooks/useBeadSideDrawer.ts";
import { useShellStore } from "../../../../src/dashboard/stores/shell.ts";
import type { UseSpecialistHistoryState } from "../../../../src/dashboard/hooks/useSpecialistHistory.ts";
import type { BeadIssue } from "../../../../src/types/beads.ts";

const specialistHistory = vi.hoisted((): { value: UseSpecialistHistoryState } => ({
  value: { count: 2, jobs: [], loading: false, error: null },
}));

vi.mock("../../../../src/dashboard/hooks/useSpecialistOwnership.ts", () => ({ useSpecialistOwnership: () => ({ role: "executor", state: "running", repoSlug: "gitboard", jobId: "job-1" }) }));
vi.mock("../../../../src/dashboard/hooks/useSpecialistHistory.ts", () => ({ useSpecialistHistory: () => specialistHistory.value }));
vi.mock("../../../../src/dashboard/lib/beads.ts", () => ({ substrateApi: { getIssue: vi.fn(async () => ({ ...issue("forge-b2", "Beta"), dependents: [{ id: "forge-b1", title: "Alpha", status: "open", dependency_type: "related" }], source: "dolt", sourceHealth: [] })) } }));
vi.mock("../../../../src/dashboard/components/beads/IssueFeed.tsx", () => ({ IssueDossier: () => <div data-testid="issue-dossier" /> }));
vi.mock("../../../../src/dashboard/components/specialists/BeadActivityPane.tsx", () => ({
  BeadActivityPane: ({ beadId, chainIdHint }: { beadId: string; chainIdHint?: string | null }) => <div data-testid="activity-pane">{beadId}:{chainIdHint ?? "no-chain"}</div>,
}));

import { BeadSideDrawer } from "../../../../src/dashboard/pages/console/BeadSideDrawer.tsx";

beforeEach(() => {
  specialistHistory.value = { count: 2, jobs: [], loading: false, error: null };
  useBeadSideDrawer.setState({
    beadId: null,
    jobId: null,
    chainId: null,
    projectId: "gitboard",
    issueById: new Map([["forge-b1", issue("forge-b1", "Alpha")], ["forge-b2", issue("forge-b2", "Beta")]]),
    fallbackIssue: null,
    memories: [{ id: "mem-1", content: "forge-b2 memory", type: "learned", tags: ["x"], created_at: "2026-01-01T00:00:00.000Z", issue_id: "forge-b2", project_id: "gitboard" }],
    tab: "overview",
    backStack: [],
  });
  useShellStore.setState({ selection: { surface: "console", tab: "graph", repo: "gitboard" } as never });
  document.body.style.overflow = "";
});

describe("Console BeadSideDrawer", () => {
  it("renders inspector tabs and preserves back navigation across lineage clicks", async () => {
    act(() => useBeadSideDrawer.getState().open("forge-b2"));
    render(<BeadSideDrawer />);

    expect(await screen.findByRole("complementary", { name: /issue inspector/i })).toBeTruthy();
    expect(screen.getByLabelText("xtrm / issue / forge-b2")).toBeInTheDocument();
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
    act(() => useBeadSideDrawer.getState().open({ beadId: "forge-b2", jobId: "job-1", chainId: "chain-1" }));
    render(<BeadSideDrawer />);

    fireEvent.click(await screen.findByRole("tab", { name: /activity/i }));
    expect(screen.getByTestId("activity-pane")).toHaveTextContent("forge-b2:chain-1");

    fireEvent.click(screen.getByRole("tab", { name: /memories/i }));
    expect(screen.getByText("forge-b2 memory")).toBeInTheDocument();
  });

  it("renders specialist history as evidence proof rows with an activity jump", async () => {
    specialistHistory.value = {
      count: 1,
      jobs: [{
        repoSlug: "gitboard",
        beadId: "forge-b2",
        jobId: "job-proof",
        chainId: "chain-1",
        epicId: null,
        chainKind: "executor",
        specialist: "executor",
        status: "done",
        updatedAt: "2026-01-02T00:00:00.000Z",
        lastOutput: "Tests passed and result captured for the drawer.",
        turns: null,
        tools: null,
        model: null,
      }],
      loading: false,
      error: null,
    };
    act(() => useBeadSideDrawer.getState().open({ beadId: "forge-b2", jobId: "job-proof" }));
    render(<BeadSideDrawer />);

    fireEvent.click(await screen.findByRole("tab", { name: /evidence/i }));

    expect(screen.getByText("executor proof")).toBeInTheDocument();
    expect(screen.getByText("passed")).toBeInTheDocument();
    expect(screen.getByText("job-proof")).toBeInTheDocument();
    expect(screen.getByText(/Tests passed and result captured/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /view activity/i }));
    expect(screen.getByTestId("activity-pane")).toHaveTextContent("forge-b2");
  });

  it("open in feed preserves shell routing", async () => {
    vi.stubGlobal("CSS", { escape: (value: string) => value } as typeof CSS);
    act(() => useBeadSideDrawer.getState().open("forge-b2"));
    render(<BeadSideDrawer />);

    fireEvent.click(await screen.findByRole("button", { name: "Open in Issues" }));

    expect(useShellStore.getState().selection.tab).toBe("feed");
    expect(useBeadSideDrawer.getState().beadId).toBeNull();
  });

  it("does not lock body scroll or close on backdrop click", async () => {
    document.body.style.overflow = "auto";
    act(() => useBeadSideDrawer.getState().open("forge-b2"));
    render(<BeadSideDrawer />);

    await screen.findByRole("complementary", { name: /issue inspector/i });
    expect(document.body.style.overflow).toBe("auto");

    fireEvent.click(document.querySelector(".bead-side-drawer-backdrop") as Element);
    expect(useBeadSideDrawer.getState().beadId).toBe("forge-b2");
  });

  it("opens around half the viewport and resizes horizontally", async () => {
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    act(() => useBeadSideDrawer.getState().open("forge-b2"));
    render(<BeadSideDrawer />);

    const drawer = await screen.findByRole("complementary", { name: /issue inspector/i });
    expect(drawer).toHaveStyle({ width: "600px" });

    fireEvent.pointerDown(screen.getByRole("button", { name: /resize bead inspector/i }), { clientX: 600, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 480 });
    expect(drawer).toHaveStyle({ width: "720px" });
    fireEvent.pointerUp(document);
  });

  it("closes from Escape", async () => {
    act(() => useBeadSideDrawer.getState().open("forge-b2"));
    render(<BeadSideDrawer />);

    await screen.findByRole("complementary", { name: /issue inspector/i });
    fireEvent.keyDown(document, { key: "Escape" });

    expect(useBeadSideDrawer.getState().beadId).toBeNull();
  });

  it("retargets the open inspector when another bead is opened", async () => {
    act(() => useBeadSideDrawer.getState().open("forge-b2"));
    render(<BeadSideDrawer />);

    expect(await screen.findByLabelText("xtrm / issue / forge-b2")).toBeInTheDocument();

    act(() => useBeadSideDrawer.getState().open("forge-b1"));

    expect(screen.getByLabelText("xtrm / issue / forge-b1")).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(useBeadSideDrawer.getState().beadId).toBe("forge-b1");
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
