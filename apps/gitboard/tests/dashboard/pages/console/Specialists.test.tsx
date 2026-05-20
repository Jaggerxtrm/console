/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useBeadSideDrawer } from "../../../../src/dashboard/hooks/useBeadSideDrawer.ts";
import { useShellStore } from "../../../../src/dashboard/stores/shell.ts";

vi.mock("../../../../src/dashboard/hooks/useSpecialistOwnership.ts", () => ({ useSpecialistOwnership: () => ({ role: "executor", state: "running", repoSlug: "gitboard", jobId: "job-1" }) }));
vi.mock("../../../../src/dashboard/hooks/useSpecialistHistory.ts", () => ({ useSpecialistHistory: () => ({ count: 2, jobs: [], loading: false, error: null }) }));
vi.mock("../../../../src/dashboard/lib/beads-api.ts", () => ({ beadsApi: { getIssue: vi.fn(async () => ({ id: "forge-b2", title: "Beta", priority: 1, issue_type: "task", status: "open", description: null, notes: null, labels: [], related_ids: [], dependencies: [], project_id: "gitboard" })) } }));
vi.mock("../../components/beads/IssueFeed.tsx", () => ({ IssueDossier: () => <div data-testid="issue-dossier" /> }));

import { BeadSideDrawer } from "../../../../src/dashboard/pages/console/BeadSideDrawer.tsx";

beforeEach(() => {
  useBeadSideDrawer.setState({ beadId: null, projectId: "gitboard", issueById: new Map([["forge-b2", { id: "forge-b2", title: "Beta", priority: 1, issue_type: "task", status: "open", description: null, notes: null, labels: [], related_ids: [], dependencies: [], project_id: "gitboard" } as never]]), open: useBeadSideDrawer.getState().open, close: useBeadSideDrawer.getState().close, setContext: useBeadSideDrawer.getState().setContext } as never);
  useShellStore.setState({ selection: { surface: "console", tab: "graph", repo: "gitboard" } as never });
});

describe("Specialists", () => {
  it("shows chains, filters, detail, and opens bead from card", async () => {
    const target = document.createElement("div");
    target.setAttribute("data-bead-id", "forge-b2");
    target.scrollIntoView = scroll;
    document.body.appendChild(target);

    useBeadSideDrawer.getState().open("forge-b2");
    render(<BeadSideDrawer />);

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(useBeadSideDrawer.getState().beadId).toBeNull());

    useBeadSideDrawer.getState().open("forge-b2");
    render(<BeadSideDrawer />);
    fireEvent.click(document.querySelector(".bead-side-drawer-backdrop") as Element);
    await waitFor(() => expect(useBeadSideDrawer.getState().beadId).toBeNull());

    useBeadSideDrawer.getState().open("forge-b2");
    render(<BeadSideDrawer />);
    fireEvent.click(screen.getAllByRole("button", { name: "Open in Feed" })[0]!);
    expect(useShellStore.getState().selection.tab).toBe("feed");
    document.body.removeChild(target);
  });

});
