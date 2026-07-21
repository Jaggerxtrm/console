/** @vitest-environment happy-dom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainJob, ChainSummary, UseChainsOptions } from "../../../../src/dashboard/hooks/useChains.ts";
import { useBeadSideDrawer } from "../../../../src/dashboard/hooks/useBeadSideDrawer.ts";

const chainBJobs = [
  job({ chainId: "chain-b", beadId: "forge-2", jobId: "job-chain-b-first", status: "running", updatedAt: "2026-05-31T00:00:00.000Z" }),
  job({ chainId: "chain-b", beadId: "forge-2", jobId: "job-chain-b-latest", status: "done", updatedAt: "2026-05-31T00:01:00.000Z" }),
];

const useChainsMock = vi.fn((_options?: UseChainsOptions) => ({ chains: [
  chain({ chainId: "chain-a", rootBeadId: "forge-1", title: "chain-a", status: "running" }),
  chain({ chainId: "chain-b", rootBeadId: "forge-2", title: "chain-b", status: "done", jobs: chainBJobs }),
], loading: false, error: null }));

const unexpectedFetches: string[] = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/api/specialists/chains/")) {
    const detailJobs = url.endsWith("/chain-b") ? chainBJobs : chain({ chainId: "chain-a", rootBeadId: "forge-1", status: "running" }).jobs;
    return new Response(JSON.stringify({ chain: { jobs: detailJobs } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.includes("/api/specialists/jobs/")) {
    return new Response(JSON.stringify({ text: "" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.includes("/api/substrate/")) {
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  unexpectedFetches.push(url);
  return new Response("unexpected request", { status: 599 });
});

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
    fetchMock.mockClear();
    unexpectedFetches.length = 0;
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens the bead drawer with chain context", async () => {
    const { Specialists } = await import("../../../../src/dashboard/pages/console/Specialists.tsx");
    render(<Specialists />);

    fireEvent.click(await screen.findByText("chain-b"));

    await waitFor(() => expect(useBeadSideDrawer.getState().beadId).toBe("forge-2"));
    expect(useBeadSideDrawer.getState().chainId).toBe("chain-b");
    expect(useBeadSideDrawer.getState().jobId).toBe("job-chain-b-latest");
    expect(useBeadSideDrawer.getState().tab).toBe("activity");
    expect(fetchMock).toHaveBeenCalled();
    expect(unexpectedFetches).toEqual([]);
    expect(fetchMock.mock.calls.every(([input]) => String(input).startsWith("/api/"))).toBe(true);
  });
});

function job(overrides: Partial<ChainJob> = {}): ChainJob {
  const chainId = overrides.chainId ?? "chain-a";
  const beadId = overrides.beadId ?? "forge-1";
  return {
    repoSlug: "repo-a",
    beadId,
    jobId: overrides.jobId ?? `job-${chainId}`,
    chainId,
    epicId: null,
    chainKind: "executor",
    specialist: "executor",
    status: overrides.status ?? "running",
    updatedAt: overrides.updatedAt ?? "2026-05-31T00:00:00.000Z",
    lastOutput: "running",
    turns: null,
    tools: null,
    model: null,
    ...overrides,
  };
}

function chain(overrides: Partial<ChainSummary> = {}): ChainSummary {
  const chainId = overrides.chainId ?? "chain-a";
  const rootBeadId = overrides.rootBeadId ?? "forge-1";
  const status = overrides.status ?? "running";
  return {
    chainId,
    rootBeadId,
    title: overrides.title ?? chainId,
    jobs: overrides.jobs ?? [job({ chainId, beadId: rootBeadId, status })],
    status,
    roles: [{ role: "executor", status }],
    elapsedMs: 0,
    lastMessage: "running",
    lastUpdatedAt: "2026-05-31T00:00:00.000Z",
    ...overrides,
  };
}
