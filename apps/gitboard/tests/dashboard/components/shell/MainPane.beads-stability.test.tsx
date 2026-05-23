/** @vitest-environment happy-dom */

import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoNode } from "../../../../src/types/shell.ts";

vi.mock("../../../../src/dashboard/components/shell/BottomDrawer.tsx", () => ({ BottomDrawer: () => <div data-testid="bottom-drawer" /> }));
vi.mock("../../../../src/dashboard/components/beads/BeadsRepoView.tsx", () => ({ BeadsRepoView: ({ repo }: { repo: RepoNode }) => <div data-testid="beads-view">{repo.displayName}</div> }));
vi.mock("../../../../src/dashboard/pages/console/Graph.tsx", () => ({ Graph: () => <div data-testid="graph" /> }));
vi.mock("../../../../src/dashboard/pages/console/Observability.tsx", () => ({ Observability: () => <div data-testid="observability" /> }));
vi.mock("../../../../src/dashboard/pages/console/Specialists.tsx", () => ({ Specialists: () => <div data-testid="specialists" /> }));

import { MainPane } from "../../../../src/dashboard/components/shell/MainPane.tsx";
import { useShellStore } from "../../../../src/dashboard/stores/shell.ts";

const repo = (fullName: string): RepoNode => ({
  fullName,
  displayName: fullName.split("/")[1] ?? fullName,
  lastActivityAt: null,
  openBeadsCount: 1,
  githubStats: { openPRs: 0, commitsToday: 0, openIssues: 0, releases: 0 },
  beadsStats: { open: 1, inProgress: 0, blocked: 0, epics: 0 },
  beadsSource: { label: "dolt", title: "Beads reading from Dolt", healthy: true },
  hasGithub: true,
  hasBeads: true,
});

beforeEach(() => {
  useShellStore.setState({ repos: [], selection: { surface: "console", tab: "feed", repo: null } });
});

describe("MainPane beads stability", () => {
  it("keeps the selected beads page mounted when repo refresh temporarily drops it", () => {
    const fullName = "owner/gitboard";
    useShellStore.setState({ repos: [repo(fullName)], selection: { surface: "console", tab: "feed", repo: fullName } });

    render(<MainPane />);

    expect(screen.getByTestId("beads-view")).toHaveTextContent("gitboard");

    act(() => useShellStore.getState().setRepos([]));

    expect(screen.getByTestId("beads-view")).toHaveTextContent("gitboard");
    expect(screen.queryByText("Pick a project")).not.toBeInTheDocument();
  });
});
