/** @vitest-environment happy-dom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChainListRow } from "../../../../src/dashboard/pages/console/specialists/ChainListRow.tsx";
import { IssueContextChip } from "../../../../src/dashboard/pages/console/specialists/IssueContextChip.tsx";
import { logClientEvent } from "../../../../src/dashboard/lib/client-log.ts";
import type { ChainSummary } from "../../../../src/dashboard/hooks/useChains.ts";
import type { ChainIssueContext } from "../../../../src/dashboard/pages/console/specialists/chainIssueContext.ts";
import type { GraphNode } from "../../../../src/types/graph.ts";

vi.mock("../../../../src/dashboard/lib/client-log.ts", () => ({
  logClientEvent: vi.fn(),
}));

afterEach(() => cleanup());

describe("ChainListRow", () => {
  it("renders identity, status, roles, and latest job id", () => {
    render(<ChainListRow chain={chain()} issueContext={issueContext()} />);

    expect(screen.getAllByText("forge-1").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("chain-a")).toBeInTheDocument();
    expect(screen.getByText("starting")).toBeInTheDocument();
    expect(screen.getByText("executor, reviewer")).toBeInTheDocument();
    expect(screen.getByText("job-review")).toBeInTheDocument();
    expect(screen.getByText("forge-related")).toBeInTheDocument();
    expect(screen.getByText("Related dependency")).toBeInTheDocument();
    expect(screen.getByText("blocks")).toBeInTheDocument();
  });

  it("keeps graph-style issue chips stable across type and priority variants", () => {
    const types = ["bug", "feature", "task", "epic", "chore"] as const;
    const priorities = [0, 1, 2, 3, 4] as const;

    for (const type of types) {
      for (const priority of priorities) {
        const { container, unmount } = render(<IssueContextChip node={graphNode({ id: `${type}-${priority}`, type, priority })} relation="blocks" />);
        expect(container.querySelector(".spec-issue-chip.g-node")).toBeTruthy();
        expect(container.querySelector(".g-pri")?.textContent).toBe(`P${priority}`);
        expect(container.querySelector(".g-type")?.textContent).toBe(type);
        expect(container.firstChild).toMatchSnapshot(`${type}-p${priority}`);
        unmount();
      }
    }

    expect(logClientEvent).not.toHaveBeenCalledWith("cockpit.row.palette.mismatch", expect.anything());
  });
});

function chain(): ChainSummary {
  return {
    chainId: "chain-a",
    rootBeadId: "forge-1",
    title: "chain-a",
    jobs: [
      job("job-exec", "executor"),
      job("job-review", "reviewer"),
    ],
    status: "starting",
    roles: [
      { role: "executor", status: "starting" },
      { role: "reviewer", status: "waiting" },
    ],
    elapsedMs: 0,
    lastMessage: "waiting for review",
    lastUpdatedAt: "2026-05-31T00:01:00.000Z",
  };
}

function issueContext(): ChainIssueContext {
  return {
    touched: [{
      id: "forge-1",
      title: "Root issue",
      type: "task",
      priority: 1,
      status: "in_progress",
      assignee: null,
      closed_at: null,
      superseded_by: null,
    }],
    related: [{
      node: {
        id: "forge-related",
        title: "Related dependency",
        type: "bug",
        priority: 0,
        status: "blocked",
        assignee: null,
        closed_at: null,
        superseded_by: null,
      },
      edge: { from: "forge-1", to: "forge-related", type: "blocks" },
      direction: "outgoing",
    }],
  };
}

function job(jobId: string, specialist: string) {
  return {
    repoSlug: "gitboard",
    beadId: "forge-1",
    jobId,
    chainId: "chain-a",
    epicId: null,
    chainKind: specialist,
    specialist,
    status: "starting",
    updatedAt: "2026-05-31T00:01:00.000Z",
    lastOutput: null,
    turns: null,
    tools: null,
    model: null,
  };
}

function graphNode(overrides: Partial<GraphNode>): GraphNode {
  return {
    id: "forge-node",
    title: "Graph issue chip",
    type: "task",
    priority: 2,
    status: "open",
    assignee: null,
    closed_at: null,
    superseded_by: null,
    ...overrides,
  };
}
