/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TopBar } from "../../../../src/dashboard/components/shell/TopBar.tsx";
import { useBeadSideDrawer } from "../../../../src/dashboard/hooks/useBeadSideDrawer.ts";
import { useShellStore } from "../../../../src/dashboard/stores/shell.ts";

beforeEach(() => {
  useShellStore.setState({ selection: { surface: "console", tab: "feed", repo: "gitboard" } as never });
  useBeadSideDrawer.setState({
    beadId: null,
    jobId: null,
    fallbackIssue: null,
    lastTarget: null,
    tab: "overview",
    backStack: [],
  });
});

describe("TopBar inspector action", () => {
  it("reopens the last bead inspector target", () => {
    render(<TopBar />);

    const action = screen.getByRole("button", { name: "Open issue inspector" });
    expect(action).toBeDisabled();

    act(() => {
      useBeadSideDrawer.getState().open({ beadId: "forge-topbar", tab: "activity" });
      useBeadSideDrawer.getState().close();
    });

    expect(action).not.toBeDisabled();

    fireEvent.click(action);

    expect(useBeadSideDrawer.getState().beadId).toBe("forge-topbar");
    expect(useBeadSideDrawer.getState().tab).toBe("activity");
  });
});
