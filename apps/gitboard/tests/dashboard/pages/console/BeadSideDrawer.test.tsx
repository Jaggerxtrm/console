/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useBeadSideDrawer } from "../../../../src/dashboard/hooks/useBeadSideDrawer.ts";
import { useShellStore } from "../../../../src/dashboard/stores/shell.ts";

vi.mock("../../../../src/dashboard/hooks/useSpecialistOwnership.ts", () => ({ useSpecialistOwnership: () => ({ role: "executor", state: "running", repoSlug: "gitboard", jobId: "job-1" }) }));
vi.mock("../../../../src/dashboard/hooks/useSpecialistHistory.ts", () => ({ useSpecialistHistory: () => ({ count: 2, jobs: [], loading: false, error: null }) }));
vi.mock("../../../../src/dashboard/lib/beads.ts", () => ({ substrateApi: { getIssue: vi.fn(async () => ({ id: "forge-b2", title: "Beta", priority: 1, issue_type: "task", status: "open", description: null, notes: null, labels: [], related_ids: [], dependencies: [], project_id: "gitboard" })) } }));
vi.mock("../../../../src/dashboard/components/beads/IssueFeed.tsx", () => ({ IssueDossier: () => <div data-testid="issue-dossier" /> }));

import { BeadSideDrawer } from "../../../../src/dashboard/pages/console/BeadSideDrawer.tsx";

beforeEach(() => {
  useBeadSideDrawer.setState({ beadId: null, projectId: "gitboard", issueById: new Map([["forge-b2", { id: "forge-b2", title: "Beta", priority: 1, issue_type: "task", status: "open", description: null, notes: null, labels: [], related_ids: [], dependencies: [], project_id: "gitboard" } as never]]), open: useBeadSideDrawer.getState().open, close: useBeadSideDrawer.getState().close, setContext: useBeadSideDrawer.getState().setContext } as never);
  useShellStore.setState({ selection: { surface: "console", tab: "graph", repo: "gitboard" } as never });
  document.body.style.overflow = "";
});

describe("BeadSideDrawer", () => {
  it("opens as a non-modal inspector, handles ESC, and opens in issues", async () => {
    vi.stubGlobal("CSS", { escape: (value: string) => value } as typeof CSS);
    document.body.style.overflow = "auto";

    useBeadSideDrawer.getState().open("forge-b2");
    render(<BeadSideDrawer />);

    expect(await screen.findByRole("complementary", { name: /issue inspector/i })).toBeTruthy();
    expect(screen.getByLabelText("xtrm / issue / forge-b2")).toBeTruthy();
    expect(document.body.style.overflow).toBe("auto");
    expect(screen.getByText("Beta")).toBeTruthy();

    fireEvent.click(document.querySelector(".bead-side-drawer-backdrop") as Element);
    expect(useBeadSideDrawer.getState().beadId).toBe("forge-b2");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(useBeadSideDrawer.getState().beadId).toBeNull());

    useBeadSideDrawer.getState().open("forge-b2");
    render(<BeadSideDrawer />);
    fireEvent.click(screen.getAllByRole("button", { name: "Open in Issues" })[0]!);
    expect(useShellStore.getState().selection.tab).toBe("feed");
  });

});
