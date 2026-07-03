/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    notes: overrides.notes ?? null,
    status: overrides.status ?? "open",
    priority: overrides.priority ?? 2,
    issue_type: overrides.issue_type ?? "task",
    created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-01-02T00:00:00.000Z",
    closed_at: overrides.closed_at,
    dependencies: overrides.dependencies ?? [],
    related_ids: overrides.related_ids ?? [],
    labels: overrides.labels ?? [],
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
  return (
    <IssueRow
      issue={issue}
      agent={null}
      dependencyCount={0}
      childCount={0}
      onOpen={() => onOpen(issue)}
      onSpecialistOpen={vi.fn()}
      depth={0}
      relation="parent"
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

  it("sorts and filters visible feed rows from the toolbar", async () => {
    render(
      <IssueFeed
        issues={[
          makeIssue({ id: "forge-old-p1", title: "Older urgent", priority: 1, updated_at: "2026-01-01T00:00:00.000Z" }),
          makeIssue({ id: "forge-new-p2", title: "Newer normal", priority: 2, updated_at: "2026-01-05T00:00:00.000Z" }),
          makeIssue({ id: "forge-new-p1", title: "Newer urgent", priority: 1, updated_at: "2026-01-04T00:00:00.000Z" }),
        ]}
        selectedIssueId={null}
        selectedIssueDetail={null}
        loadingDetailId={null}
        onIssueSelect={vi.fn()}
        projectId="gitboard"
      />,
    );

    expect(await screen.findByText("Newer normal")).toBeInTheDocument();
    expect(screen.getByText("Newer urgent")).toBeInTheDocument();
    expect(screen.getByText("Older urgent")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter beads by priority"), { target: { value: "1" } });
    expect(screen.queryByText("Newer normal")).not.toBeInTheDocument();
    expect(screen.getByText("Newer urgent")).toBeInTheDocument();
    expect(screen.getByText("Older urgent")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Sort beads"), { target: { value: "updated-asc" } });
    const rows = screen.getAllByRole("button", { expanded: false }).map((row) => row.textContent ?? "");
    expect(rows.findIndex((text) => text.includes("Older urgent"))).toBeLessThan(rows.findIndex((text) => text.includes("Newer urgent")));
  });

  it("searches note-only content and shows the match reason", async () => {
    render(
      <IssueFeed
        issues={[
          makeIssue({ id: "forge-note", title: "Drawer work", notes: "Canonical inspector preserves scroll context" }),
          makeIssue({ id: "forge-other", title: "Graph polish", notes: "No matching phrase here" }),
        ]}
        selectedIssueId={null}
        selectedIssueDetail={null}
        loadingDetailId={null}
        onIssueSelect={vi.fn()}
        projectId="gitboard"
      />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search beads in this project" }), { target: { value: "preserves scroll" } });

    expect(await screen.findByText("Drawer work")).toBeInTheDocument();
    expect(screen.queryByText("Graph polish")).not.toBeInTheDocument();
    expect(screen.getByText(/notes: canonical inspector preserves scroll context/i)).toBeInTheDocument();
  });

  it("sorts visible feed rows by created time independently of updated time", async () => {
    render(
      <IssueFeed
        issues={[
          makeIssue({ id: "forge-created-mid", title: "Created middle", created_at: "2026-01-02T08:30:00.000Z", updated_at: "2026-02-01T00:00:00.000Z" }),
          makeIssue({ id: "forge-created-new", title: "Created newest", created_at: "\"2026-01-03T09:00:00.000Z\"", updated_at: "2026-01-01T00:00:00.000Z" }),
          makeIssue({ id: "forge-created-old", title: "Created oldest", created_at: "2026-01-01T07:00:00.000Z", updated_at: "2026-03-01T00:00:00.000Z" }),
        ]}
        selectedIssueId={null}
        selectedIssueDetail={null}
        loadingDetailId={null}
        onIssueSelect={vi.fn()}
        projectId="gitboard"
      />,
    );

    fireEvent.change(screen.getByLabelText("Sort beads"), { target: { value: "created-asc" } });
    let rows = screen.getAllByRole("button", { expanded: false }).map((row) => row.textContent ?? "");
    expect(rows.findIndex((text) => text.includes("Created oldest"))).toBeLessThan(rows.findIndex((text) => text.includes("Created middle")));
    expect(rows.findIndex((text) => text.includes("Created middle"))).toBeLessThan(rows.findIndex((text) => text.includes("Created newest")));

    fireEvent.change(screen.getByLabelText("Sort beads"), { target: { value: "created-desc" } });
    rows = screen.getAllByRole("button", { expanded: false }).map((row) => row.textContent ?? "");
    expect(rows.findIndex((text) => text.includes("Created newest"))).toBeLessThan(rows.findIndex((text) => text.includes("Created middle")));
    expect(rows.findIndex((text) => text.includes("Created middle"))).toBeLessThan(rows.findIndex((text) => text.includes("Created oldest")));
  });

  it("renders epic children deeper than one nesting level", async () => {
    render(
      <IssueFeed
        issues={[
          makeIssue({
            id: "forge-epic",
            title: "Top epic",
            issue_type: "epic",
            dependencies: [{ id: "forge-epic.1", title: "Child epic", status: "open", issue_type: "epic", dependency_type: "parent-child" }],
          }),
          makeIssue({
            id: "forge-epic.1",
            title: "Child epic",
            issue_type: "epic",
            dependencies: [{ id: "forge-epic.1.1", title: "Grandchild task", status: "open", issue_type: "task", dependency_type: "parent-child" }],
          }),
          makeIssue({ id: "forge-epic.1.1", title: "Grandchild task", issue_type: "task" }),
        ]}
        selectedIssueId={null}
        selectedIssueDetail={null}
        loadingDetailId={null}
        onIssueSelect={vi.fn()}
        projectId="gitboard"
      />,
    );

    expect(await screen.findByText("Top epic")).toBeInTheDocument();
    expect(screen.getByText("Child epic")).toBeInTheDocument();
    expect(screen.getByText("Grandchild task")).toBeInTheDocument();
    expect(getRenderedDepth("forge-epic")).toBe("0");
    expect(getRenderedDepth("forge-epic.1")).toBe("1");
    expect(getRenderedDepth("forge-epic.1.1")).toBe("2");
  });

  it("keeps descendants visible when filtering the feed to epics", async () => {
    render(
      <IssueFeed
        issues={[
          makeIssue({
            id: "forge-visible-epic",
            title: "Visible epic",
            issue_type: "epic",
            dependencies: [{ id: "forge-visible-epic.1", title: "Visible child task", status: "open", issue_type: "task", dependency_type: "parent-child" }],
          }),
          makeIssue({ id: "forge-visible-epic.1", title: "Visible child task", issue_type: "task" }),
          makeIssue({ id: "forge-hidden-task", title: "Hidden unrelated task", issue_type: "task" }),
        ]}
        selectedIssueId={null}
        selectedIssueDetail={null}
        loadingDetailId={null}
        onIssueSelect={vi.fn()}
        projectId="gitboard"
      />,
    );

    fireEvent.change(screen.getByLabelText("Filter beads by type"), { target: { value: "epic" } });

    expect(await screen.findByText("Visible epic")).toBeInTheDocument();
    expect(screen.getByText("Visible child task")).toBeInTheDocument();
    expect(screen.queryByText("Hidden unrelated task")).not.toBeInTheDocument();
  });

  it("keeps children visible for missing parent epics when dependency metadata identifies the epic", async () => {
    render(
      <IssueFeed
        issues={[
          makeIssue({
            id: "forge-closed-epic.1",
            title: "Child of closed epic",
            issue_type: "task",
            parent_id: "forge-closed-epic",
            dependencies: [{ id: "forge-closed-epic", title: "Closed epic", status: "closed", issue_type: "epic", dependency_type: "parent-child" }],
          }),
          makeIssue({ id: "forge-unrelated-task", title: "Unrelated task", issue_type: "task" }),
        ]}
        selectedIssueId={null}
        selectedIssueDetail={null}
        loadingDetailId={null}
        onIssueSelect={vi.fn()}
        projectId="gitboard"
      />,
    );

    fireEvent.change(screen.getByLabelText("Filter beads by type"), { target: { value: "epic" } });

    expect(await screen.findByText("Child of closed epic")).toBeInTheDocument();
    expect(screen.queryByText("Unrelated task")).not.toBeInTheDocument();
  });

  it("opens the inspector from row click without expanding an inline preview", async () => {
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);

    fireEvent.click(await screen.findByText("Stabilize feed"));

    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "forge-1" }));
    expect(screen.queryByText("Description")).not.toBeInTheDocument();
    expect(screen.queryByText("Labels")).not.toBeInTheDocument();
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
        agent={null}
        dependencyCount={1}
        childCount={0}
        onOpen={vi.fn()}
        onSpecialistOpen={vi.fn()}
        depth={0}
        relation="parent"
        issueById={new Map([[issue.id, issueWithUntitledDependency]])}
      />,
    );

    expect(screen.getByText("validates:")).toBeInTheDocument();
    expect(screen.getByText("forge-unknown")).toBeInTheDocument();
    expect(screen.getByTitle("validates: forge-unknown")).toBeInTheDocument();
  });
});

function getRenderedDepth(beadId: string): string | undefined {
  return (document.querySelector(`[data-bead-id="${beadId}"]`) as HTMLElement | null)?.style.getPropertyValue("--bead-depth");
}
