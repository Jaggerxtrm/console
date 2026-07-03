/** @vitest-environment happy-dom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainSummary, UseChainsOptions } from "../../../../src/dashboard/hooks/useChains.ts";
import { useBeadSideDrawer } from "../../../../src/dashboard/hooks/useBeadSideDrawer.ts";

const useChainsMock = vi.fn((_options?: UseChainsOptions) => ({ chains: [
  chain({ chainId: "chain-a", rootBeadId: "forge-1", title: "chain-a", status: "running" }),
  chain({ chainId: "chain-b", rootBeadId: "forge-2", title: "chain-b", status: "done" }),
], loading: false, error: null }));

vi.mock("../../../../src/dashboard/hooks/useChains.ts", () => ({
  useChains: (options?: UseChainsOptions) => useChainsMock(options),
}));

vi.mock("../../../../src/dashboard/hooks/useGraphData.ts", () => ({
  useGraphData: () => ({
    data: {
      project_id: "project-a",
      repo_slug: "repo-a",
      generated_at: "2026-05-31T00:00:00.000Z",
      nodes: [
        { id: "forge-1", title: "Root issue", type: "task", priority: 1, status: "in_progress", assignee: null, closed_at: null, superseded_by: null },
        { id: "forge-2", title: "Second issue", type: "bug", priority: 2, status: "open", assignee: null, closed_at: null, superseded_by: null },
      ],
      edges: [],
      specialists: [],
    },
    loading: false,
    error: null,
    reload: vi.fn(),
  }),
}));

vi.mock("../../../../src/dashboard/lib/client-log.ts", () => ({
  logClientEvent: vi.fn(),
}));

describe("Console Specialists drawer routing", () => {
  beforeEach(async () => {
    const { useShellStore } = await import("../../../../src/dashboard/stores/shell.ts");
    act(() => {
      useBeadSideDrawer.setState({
        beadId: null,
        jobId: null,
        chainId: null,
        projectId: "project-a",
        issueById: new Map(),
        fallbackIssue: null,
        memories: [],
        tab: "overview",
        backStack: [],
      });
      useShellStore.getState().setRepos([{
        fullName: "owner/repo-a",
        displayName: "repo-a",
        lastActivityAt: null,
        openBeadsCount: 0,
        githubStats: { openPRs: 0, commitsToday: 0, openIssues: 0, releases: 0 },
        beadsStats: { open: 0, inProgress: 0, blocked: 0, epics: 0 },
        beadsSource: { label: "dolt", title: "Beads reading from Dolt", healthy: true },
        beadsProjectId: "project-a",
        beadsProjectName: "repo-a",
        hasGithub: true,
        hasBeads: true,
      }]);
      useShellStore.getState().setSurface("console");
      useShellStore.getState().setRepo("owner/repo-a");
    });
  });

  afterEach(() => cleanup());

  it("opens the bead drawer with chain context", async () => {
    const { Specialists } = await import("../../../../src/dashboard/pages/console/Specialists.tsx");
    render(<Specialists />);

    fireEvent.click(await screen.findByText("chain-b"));

    await waitFor(() => expect(useBeadSideDrawer.getState().beadId).toBe("forge-2"));
    expect(useBeadSideDrawer.getState().chainId).toBe("chain-b");
    expect(useBeadSideDrawer.getState().jobId).toBe("job-chain-b");
    expect(useBeadSideDrawer.getState().tab).toBe("activity");
  });
});

function chain(overrides: Partial<ChainSummary> = {}): ChainSummary {
  const chainId = overrides.chainId ?? "chain-a";
  const rootBeadId = overrides.rootBeadId ?? "forge-1";
  return {
    chainId,
    rootBeadId,
    title: overrides.title ?? chainId,
    jobs: [{
      repoSlug: "repo-a",
      beadId: rootBeadId,
      jobId: `job-${chainId}`,
      chainId,
      epicId: null,
      chainKind: "executor",
      specialist: "executor",
      status: overrides.status ?? "running",
      updatedAt: "2026-05-31T00:00:00.000Z",
      lastOutput: "running",
      turns: null,
      tools: null,
      model: null,
    }],
    status: overrides.status ?? "running",
    roles: [{ role: "executor", status: overrides.status ?? "running" }],
    elapsedMs: 0,
    lastMessage: "running",
    lastUpdatedAt: "2026-05-31T00:00:00.000Z",
  };
}
