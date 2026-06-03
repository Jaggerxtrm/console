/** @vitest-environment happy-dom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecialistJob } from "../../../../src/server/observability/types.ts";
import { logClientEvent } from "../../../../src/dashboard/lib/client-log.ts";

let jobs: SpecialistJob[] = [];

vi.mock("../../../../src/dashboard/hooks/useInFlightJobs.ts", () => ({
  useInFlightJobs: () => ({ jobs, groups: [], sourceEpoch: {}, loading: false, error: null }),
}));

vi.mock("../../../../src/dashboard/lib/client-log.ts", () => ({
  logClientEvent: vi.fn(),
}));

describe("SpecialistsTabPanel", () => {
  beforeEach(async () => {
    jobs = [
      specialistJob({ repoSlug: "repo-a", beadId: "forge-1", jobId: "job-a", specialist: "executor" }),
      specialistJob({ repoSlug: "repo-b", beadId: "forge-2", jobId: "job-b", specialist: "reviewer" }),
    ];
    const { useShellStore } = await import("../../../../src/dashboard/stores/shell.ts");
    act(() => {
      useShellStore.getState().setRepos([
        repo("owner/repo-a", "repo-a"),
        repo("owner/repo-b", "repo-b"),
      ]);
      useShellStore.getState().setSurface("console");
      useShellStore.getState().setRepo("owner/repo-a");
      useShellStore.getState().setDrawerSpecialistsScope("repo");
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("matches current project jobs by beads project aliases, not owner/repo", async () => {
    const { SpecialistsTabPanel } = await import("../../../../src/dashboard/components/beads/SpecialistsTabPanel.tsx");
    render(<SpecialistsTabPanel />);

    expect(screen.getByText("repo-a")).toBeInTheDocument();
    expect(screen.getByText("executor")).toBeInTheDocument();
    expect(screen.queryByText("reviewer")).not.toBeInTheDocument();
    expect(logClientEvent).toHaveBeenCalledWith("drawer.specialists.tab.opened", expect.objectContaining({ rowCount: 1, scope: "repo" }));

    fireEvent.click(screen.getByRole("button", { name: "all hosts" }));
    expect(screen.getByText("reviewer")).toBeInTheDocument();
    expect(logClientEvent).toHaveBeenCalledWith("drawer.specialists.repo_scope.toggled", expect.objectContaining({ from: "repo", to: "all-hosts", rowCountAfter: 2 }));

    fireEvent.click(screen.getByRole("button", { name: "executor" }));
    expect(logClientEvent).toHaveBeenCalledWith("drawer.specialists.chip.clicked", expect.objectContaining({ beadId: "forge-1", jobId: "job-a", target: "sidebar" }));
    expect(logClientEvent).toHaveBeenCalledWith("chip.sidebar.dispatched", expect.objectContaining({ source: "drawer_row", beadId: "forge-1", jobId: "job-a" }));
  });
});

function repo(fullName: string, projectName: string) {
  return {
    fullName,
    displayName: projectName,
    lastActivityAt: null,
    openBeadsCount: 0,
    githubStats: { openPRs: 0, commitsToday: 0, openIssues: 0, releases: 0 },
    beadsStats: { open: 0, inProgress: 0, blocked: 0, epics: 0 },
    beadsSource: { label: "dolt" as const, title: "Beads reading from Dolt", healthy: true },
    beadsProjectId: `project-${projectName}`,
    beadsProjectName: projectName,
    hasGithub: true,
    hasBeads: true,
  };
}

function specialistJob(overrides: Partial<SpecialistJob>): SpecialistJob {
  return {
    repoSlug: "repo-a",
    beadId: "forge-1",
    jobId: "job-a",
    chainId: "chain-a",
    epicId: null,
    chainKind: "executor",
    status: "running",
    updatedAt: "2026-05-31T00:00:00.000Z",
    specialist: "executor",
    lastOutput: "last line",
    turns: null,
    tools: null,
    model: null,
    ...overrides,
  };
}
