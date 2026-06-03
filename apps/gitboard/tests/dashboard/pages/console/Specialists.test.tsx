/** @vitest-environment happy-dom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainSummary, UseChainsOptions } from "../../../../src/dashboard/hooks/useChains.ts";
import { logClientEvent } from "../../../../src/dashboard/lib/client-log.ts";

const useChainsMock = vi.fn((_options?: UseChainsOptions) => ({ chains: [
  chain({ chainId: "chain-a", rootBeadId: "forge-1", title: "chain-a", status: "running" }),
  chain({ chainId: "chain-b", rootBeadId: "forge-2", title: "chain-b", status: "done" }),
  chain({ chainId: "chain-c", rootBeadId: "forge-3", title: "chain-c", status: "waiting" }),
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
        { id: "forge-related", title: "Related issue", type: "bug", priority: 0, status: "blocked", assignee: null, closed_at: null, superseded_by: null },
      ],
      edges: [{ from: "forge-1", to: "forge-related", type: "blocks" }],
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

vi.mock("../../../../src/dashboard/pages/console/specialists/ChainDetailPane.tsx", () => ({
  ChainDetailPane: ({ chain }: { chain: ChainSummary | null }) => <div data-testid="chain-detail">{chain?.chainId ?? "empty"}</div>,
}));

describe("Specialists page", () => {
  beforeEach(async () => {
    useChainsMock.mockClear();
    const { useShellStore } = await import("../../../../src/dashboard/stores/shell.ts");
    act(() => {
      useShellStore.getState().setRepos([
        {
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
        },
      ]);
      useShellStore.getState().setSurface("console");
      useShellStore.getState().setRepo("owner/repo-a");
    });
  });

  afterEach(() => cleanup());

  it("scopes chains to the selected beads project and renders chain detail", async () => {
    const { Specialists } = await import("../../../../src/dashboard/pages/console/Specialists.tsx");
    render(<Specialists />);

    expect(useChainsMock).toHaveBeenCalledWith(expect.objectContaining({ repoKeys: expect.arrayContaining(["repo-a", "project-a"]) }));
    expect(screen.getByText("repo-a")).toBeInTheDocument();
    expect(screen.getByTestId("chain-detail")).toHaveTextContent("chain-a");
    await waitFor(() => expect(logClientEvent).toHaveBeenCalledWith("cockpit.list.first_paint", expect.objectContaining({ rowCount: 3 })));
    expect(logClientEvent).toHaveBeenCalledWith("cockpit.chain.selected", { chainId: "chain-a" });

    fireEvent.click(screen.getByText("chain-b"));
    await waitFor(() => expect(screen.getByTestId("chain-detail")).toHaveTextContent("chain-b"));
    expect(logClientEvent).toHaveBeenCalledWith("cockpit.chain.selected", { chainId: "chain-b" });
    expect(logClientEvent).toHaveBeenCalledWith("cockpit.bead_activity.swapped", expect.objectContaining({ chainId: "chain-b", beadId: "forge-2" }));
  });
});

function chain(overrides: Partial<ChainSummary> = {}): ChainSummary {
  return {
    chainId: overrides.chainId ?? "chain-a",
    rootBeadId: overrides.rootBeadId ?? "forge-1",
    title: overrides.title ?? "chain-a",
    jobs: [{
      repoSlug: "repo-a",
      beadId: overrides.rootBeadId ?? "forge-1",
      jobId: `job-${overrides.chainId ?? "chain-a"}`,
      chainId: overrides.chainId ?? "chain-a",
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
