/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useBeadSideDrawer } from "../../../../src/dashboard/hooks/useBeadSideDrawer.ts";
import { useShellStore } from "../../../../src/dashboard/stores/shell.ts";

vi.mock("../../../../src/dashboard/hooks/useChains.ts", () => ({
  useChains: () => ({ chains: [{
    chainId: "chain-alpha",
    rootBeadId: "forge-op",
    title: "chain-alpha",
    status: "running",
    elapsedMs: 42_000,
    lastMessage: "executor is collecting evidence",
    lastUpdatedAt: "2026-01-01T00:01:00.000Z",
    roles: [{ role: "executor", status: "running" }],
    jobs: [{
      jobId: "job-alpha",
      repoSlug: "repo-a",
      beadId: "forge-op",
      chainId: "chain-alpha",
      epicId: null,
      chainKind: "executor",
      status: "running",
      updatedAt: "2026-01-01T00:01:00.000Z",
      specialist: "executor",
      lastOutput: "executor is collecting evidence",
      turns: 3,
      tools: 4,
      model: "gpt-5.4",
    }],
  }], loading: false, error: null }),
}));

import { Operations } from "../../../../src/dashboard/pages/console/Operations.tsx";

beforeEach(() => {
  useShellStore.setState({
    selection: { surface: "console", tab: "operations", repo: "repo/full" },
    repos: [{
      fullName: "repo/full",
      displayName: "repo",
      lastActivityAt: null,
      openBeadsCount: 1,
      githubStats: { openPRs: 0, commitsToday: 0, openIssues: 0, releases: 0 },
      beadsStats: { open: 1, inProgress: 0, blocked: 0, epics: 0 },
      beadsSource: null,
      beadsProjectId: "repo-a",
      beadsProjectName: "repo",
      hasGithub: true,
      hasBeads: true,
    }],
  } as never);
  useBeadSideDrawer.setState({ beadId: null, jobId: null, fallbackIssue: null, tab: "overview", backStack: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Console Operations query lab", () => {
  it("renders editable query controls and opens chain drawer into bead inspector", () => {
    render(<Operations />);

    expect(screen.getByDisplayValue(/from specialists\.chains/)).toBeInTheDocument();
    expect(screen.queryByText("gpt-5.4")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Model"));
    expect(screen.getByText("gpt-5.4")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /chain-alpha/i }));

    expect(screen.getByText("root bead")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /open bead inspector/i }));

    expect(useBeadSideDrawer.getState().beadId).toBe("forge-op");
  });

  it("opens template drawer without replacing the Operations surface", () => {
    render(<Operations />);

    fireEvent.click(screen.getAllByRole("button", { name: /github materializer lag/i })[0]!);

    expect(screen.getAllByText("from github.events join materializer.cursors summarize freshness by repo,resource")).toHaveLength(2);
    expect(useShellStore.getState().selection.tab).toBe("operations");
  });
});
