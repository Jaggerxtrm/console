import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { IssueDossier, IssueRow } from "../../../../src/dashboard/components/beads/IssueFeed.tsx";
import type { BeadIssue, BeadIssueDetail } from "../../../../src/types/beads.ts";

vi.mock("../../../../src/dashboard/hooks/useSpecialistHistory.ts", () => ({
  useSpecialistHistory: () => ({ count: 0, jobs: [] }),
}));

vi.mock("../../../../src/dashboard/lib/beads.ts", () => ({
  substrateApi: {
    listInteractions: vi.fn(async () => []),
  },
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

describe("Issue row render behavior", () => {
  it("expands a row into the dossier without losing description rendering", async () => {
    render(<Harness />);

    fireEvent.click(await screen.findByText("Stabilize feed"));

    expect(await screen.findByText("Description")).toBeInTheDocument();
    expect(screen.getByText("renders")).toBeInTheDocument();
    expect(screen.getByText("Labels")).toBeInTheDocument();
  });

  it("opens activity inspector from the row action without expanding the dossier", async () => {
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);

    fireEvent.click(await screen.findByRole("button", { name: /open forge-1 activity inspector/i }));

    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "forge-1" }));
    expect(screen.queryByText("Description")).not.toBeInTheDocument();
  });

  it("renders the dependency tree with relationship labels", async () => {
    const blocker: BeadIssue = {
      ...issue,
      id: "forge-blocker",
      title: "Ship blocker",
      status: "in_progress",
      priority: 0,
      dependencies: [],
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
});
