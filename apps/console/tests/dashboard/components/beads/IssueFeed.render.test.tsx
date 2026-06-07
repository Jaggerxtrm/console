/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { IssueDossier, IssueFeed, IssueRow } from "../../../../src/dashboard/components/beads/IssueFeed.tsx";
import type { BeadIssue, BeadIssueDetail } from "../../../../src/types/beads.ts";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 64,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 64 })),
    measureElement: vi.fn(),
  }),
}));

vi.mock("../../../../src/dashboard/hooks/useSpecialistHistory.ts", () => ({
  useSpecialistHistory: () => ({ count: 0, jobs: [], loading: false, error: null }),
}));

vi.mock("../../../../src/dashboard/lib/beads.ts", () => ({
  substrateApi: {
    listInteractions: vi.fn(async () => []),
  },
}));

vi.mock("../../../../src/dashboard/lib/client-log.ts", () => ({
  logClientEvent: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const issue: BeadIssue = {
  id: "forge-1",
  title: "Stabilize feed",
  description: "Description **renders** in the expanded dossier.",
  status: "open",
  priority: 1,
  issue_type: "bug",
  owner: null,
  created_at: "2026-01-01T00:00:00.000Z",
  created_by: null,
  updated_at: "2026-01-02T00:00:00.000Z",
  project_id: "gitboard",
  dependencies: [],
  related_ids: [],
  labels: ["ui"],
};

function makeIssue(overrides: Partial<BeadIssue> & Pick<BeadIssue, "id" | "title">): BeadIssue {
  return {
    ...issue,
    id: overrides.id,
    title: overrides.title,
    description: overrides.description ?? "",
    status: overrides.status ?? "open",
    priority: overrides.priority ?? 2,
    issue_type: overrides.issue_type ?? "task",
    updated_at: overrides.updated_at ?? "2026-01-02T00:00:00.000Z",
    closed_at: overrides.closed_at,
    dependencies: overrides.dependencies ?? [],
    parent_id: overrides.parent_id,
  };
}

const detail: BeadIssueDetail = {
  ...issue,
  notes: "Notes still render.",
  dependents: [],
  children: [],
  labels: ["ui"],
  source: "dolt",
  sourceHealth: [{ kind: "dolt", state: "fresh" }],
};

function Harness({ onOpen = vi.fn() }: { onOpen?: (issue: BeadIssue) => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const isExpanded = selectedId === issue.id;
  return (
    <IssueRow
      issue={issue}
      detail={isExpanded ? detail : null}
      isExpanded={isExpanded}
      isLoadingDetail={false}
      agent={null}
      dependencyCount={0}
      childCount={0}
      onClick={() => setSelectedId((current) => current === issue.id ? null : issue.id)}
      onOpen={() => onOpen(issue)}
      onSpecialistOpen={vi.fn()}
      depth={0}
      relation="parent"
      projectId="gitboard"
      issueById={new Map([[issue.id, issue]])}
    />
  );
}

describe("Console IssueFeed row guards", () => {
  it("renders in-progress, open, and closed section headers with open rows expanded by default", async () => {
    render(
      <IssueFeed
        issues={[
          makeIssue({ id: "forge-wip", title: "Active implementation", status: "in_progress", updated_at: "2026-01-04T00:00:00.000Z" }),
          makeIssue({ id: "forge-ready", title: "Ready implementation", status: "open" }),
          makeIssue({
            id: "forge-blocked",
            title: "Blocked implementation",
            status: "open",
            dependencies: [{ id: "forge-ready", title: "Ready implementation", status: "open", dependency_type: "blocked_by" }],
          }),
        ]}
        closedIssues={[makeIssue({ id: "forge-done", title: "Completed implementation", status: "closed", closed_at: "2026-01-05T00:00:00.000Z" })]}
        selectedIssueId={null}
        selectedIssueDetail={null}
        loadingDetailId={null}
        onIssueSelect={vi.fn()}
        projectId="gitboard"
      />,
    );

    expect(await screen.findByText("in progress:1")).toBeInTheDocument();
    expect(screen.getByText("open:2, ready:1")).toBeInTheDocument();
    expect(screen.getByText("closed:1")).toBeInTheDocument();
    expect(screen.getByText("Active implementation")).toBeInTheDocument();
    expect(screen.getByText("Ready implementation")).toBeInTheDocument();
    expect(screen.getByText("Blocked implementation")).toBeInTheDocument();
    expect(screen.queryByText("Completed implementation")).not.toBeInTheDocument();
  });

  it("keeps closed rows collapsed by default and expands them from the section toggle", async () => {
    render(
      <IssueFeed
        issues={[makeIssue({ id: "forge-ready", title: "Ready implementation", status: "open" })]}
        closedIssues={[makeIssue({ id: "forge-done", title: "Completed implementation", status: "closed", closed_at: "2026-01-05T00:00:00.000Z" })]}
        selectedIssueId={null}
        selectedIssueDetail={null}
        loadingDetailId={null}
        onIssueSelect={vi.fn()}
        projectId="gitboard"
      />,
    );

    expect(await screen.findByText("closed:1")).toBeInTheDocument();
    expect(screen.queryByText("Completed implementation")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /closed:1/i }));

    expect(screen.getByText("Completed implementation")).toBeInTheDocument();
  });

  it("auto-expands closed history when closed issues carry dependency context", async () => {
    render(
      <IssueFeed
        issues={[makeIssue({ id: "forge-ready", title: "Ready implementation", status: "open" })]}
        closedIssues={[
          makeIssue({
            id: "forge-done",
            title: "Completed implementation",
            status: "closed",
            closed_at: "2026-01-05T00:00:00.000Z",
            dependencies: [{ id: "forge-origin", title: "Original request", status: "closed", dependency_type: "discovered-from" }],
          }),
        ]}
        selectedIssueId={null}
        selectedIssueDetail={null}
        loadingDetailId={null}
        onIssueSelect={vi.fn()}
        projectId="gitboard"
      />,
    );

    expect(await screen.findByText("Completed implementation")).toBeInTheDocument();
  });

  it("keeps row click wired to inline dossier expansion", async () => {
    render(<Harness />);

    fireEvent.click(await screen.findByText("Stabilize feed"));

    expect(await screen.findByText("Description")).toBeInTheDocument();
    expect(screen.getByText("renders")).toBeInTheDocument();
    expect(screen.getByText("Labels")).toBeInTheDocument();
  });

  it("keeps explicit inspector affordance separate from row expansion", async () => {
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);

    fireEvent.click(await screen.findByRole("button", { name: /open forge-1 activity inspector/i }));

    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "forge-1" }));
    expect(screen.queryByText("Description")).not.toBeInTheDocument();
  });

  it("renders dependency grouping in the inline dossier", async () => {
    const blocker: BeadIssue = {
      ...issue,
      id: "forge-blocker",
      title: "Ship blocker",
      status: "in_progress",
      priority: 0,
    };
    const child = { id: "forge-child", title: "Child task", status: "open" as const, dependency_type: "parent-child" as const };
    const detailWithDeps: BeadIssueDetail = {
      ...detail,
      dependencies: [{ id: blocker.id, title: blocker.title, status: blocker.status, dependency_type: "blocked_by" }],
      children: [child],
    };

    render(
      <IssueDossier
        id="issue-dossier-forge-1"
        detail={detailWithDeps}
        issue={{ ...issue, dependencies: detailWithDeps.dependencies }}
        loading={false}
        projectId="gitboard"
        issueById={new Map([[issue.id, issue], [blocker.id, blocker]])}
      />,
    );

    expect(await screen.findByText("Dependency tree")).toBeInTheDocument();
    expect(screen.getByText("[blocked by]")).toBeInTheDocument();
    expect(screen.getByText("[child]")).toBeInTheDocument();
    expect(screen.getByText("forge-child")).toBeInTheDocument();
  });

  it("renders relationship groups and falls back to relationship/id in chip titles", async () => {
    const issueWithUntitledDependency: BeadIssue = {
      ...issue,
      dependencies: [{ id: "forge-unknown", title: "", status: "open", dependency_type: "validates" }],
    };

    render(
      <IssueRow
        issue={issueWithUntitledDependency}
        detail={null}
        isExpanded={false}
        isLoadingDetail={false}
        agent={null}
        dependencyCount={1}
        childCount={0}
        onClick={vi.fn()}
        onOpen={vi.fn()}
        onSpecialistOpen={vi.fn()}
        depth={0}
        relation="parent"
        projectId="gitboard"
        issueById={new Map([[issue.id, issueWithUntitledDependency]])}
      />,
    );

    expect(screen.getByText("validates:")).toBeInTheDocument();
    expect(screen.getByText("forge-unknown")).toBeInTheDocument();
    expect(screen.getByTitle("validates: forge-unknown")).toBeInTheDocument();
  });
});
