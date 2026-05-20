import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BeadsRepoView } from "../../../../src/dashboard/components/beads/BeadsRepoView.tsx";
import { beadsApi } from "../../../../src/dashboard/lib/beads-api.ts";
import type { BeadIssue, BeadsProject } from "../../../../src/types/beads.ts";
import type { WsMessage } from "../../../../src/dashboard/lib/ws.ts";

let wsHandler: ((msg: WsMessage) => void) | null = null;

vi.mock("../../../../src/dashboard/hooks/useWebSocket.ts", () => ({
  useWebSocket: (_channel: string, handler: (msg: WsMessage) => void) => {
    wsHandler = handler;
  },
}));

vi.mock("../../../../src/dashboard/components/beads/IssueFeed.tsx", () => ({
  IssueFeed: ({ issues, closedIssues }: { issues: BeadIssue[]; closedIssues: BeadIssue[] }) => (
    <div>
      <section aria-label="open issues">
        {issues.map((issue) => <div key={issue.id}>{issue.title}</div>)}
      </section>
      <section aria-label="closed issues">
        {closedIssues.map((issue) => <div key={issue.id}>{issue.title}</div>)}
      </section>
    </div>
  ),
}));

vi.mock("../../../../src/dashboard/components/beads/IssueOverlay.tsx", () => ({
  IssueOverlay: () => null,
}));

const project: BeadsProject = {
  id: "project-1",
  name: "repo-a",
  path: "/tmp/repo-a",
  beadsPath: "/tmp/repo-a/.beads",
  issueCount: 1,
  lastScanned: "2026-01-01T00:00:00.000Z",
  status: "active",
};

const issue: BeadIssue = {
  id: "GB-1",
  title: "Initial issue",
  description: null,
  status: "open",
  priority: 1,
  issue_type: "bug",
  owner: null,
  created_at: "2026-01-01T00:00:00.000Z",
  created_by: null,
  updated_at: "2026-01-01T00:00:00.000Z",
  project_id: project.id,
  dependencies: [],
  related_ids: [],
  labels: [],
};

beforeEach(() => {
  wsHandler = null;
  vi.restoreAllMocks();
  vi.spyOn(beadsApi, "listProjects").mockResolvedValue([project]);
  vi.spyOn(beadsApi, "listIssues").mockResolvedValue([issue]);
  vi.spyOn(beadsApi, "listClosedIssues").mockResolvedValue([]);
  vi.spyOn(beadsApi, "listMemories").mockResolvedValue([]);
  vi.spyOn(beadsApi, "listInteractions").mockResolvedValue([]);
});

describe("BeadsRepoView realtime updates", () => {
  it("renders open issues before closed history finishes loading", async () => {
    let resolveClosed!: (issues: BeadIssue[]) => void;
    vi.spyOn(beadsApi, "listClosedIssues").mockReturnValue(new Promise((resolve) => { resolveClosed = resolve; }));

    render(<BeadsRepoView repo={{ fullName: "owner/repo-a", displayName: "repo-a", lastActivityAt: null, openBeadsCount: 1, githubStats: { openPRs: 0, commitsToday: 0, openIssues: 0, releases: 0 }, beadsStats: { open: 1, inProgress: 0, blocked: 0, epics: 0 }, beadsSource: { label: "dolt", title: "Beads reading from Dolt", healthy: true }, hasGithub: true, hasBeads: true }} tab="feed" />);

    expect(await screen.findByText("Initial issue")).toBeInTheDocument();
    expect(beadsApi.listIssues).toHaveBeenCalledWith(project.id, { status: ["open", "in_progress", "blocked", "in_review"], limit: 100 });
    expect(beadsApi.listClosedIssues).toHaveBeenCalledWith(project.id, 50);

    act(() => resolveClosed([{ ...issue, id: "GB-closed", title: "Closed issue", status: "closed" }]));
    expect(await screen.findByText("Closed issue")).toBeInTheDocument();
  });

  it("updates mounted feed when a beads upsert event arrives", async () => {
    render(<BeadsRepoView repo={{ fullName: "owner/repo-a", displayName: "repo-a", lastActivityAt: null, openBeadsCount: 1, githubStats: { openPRs: 0, commitsToday: 0, openIssues: 0, releases: 0 }, beadsStats: { open: 1, inProgress: 0, blocked: 0, epics: 0 }, beadsSource: { label: "dolt", title: "Beads reading from Dolt", healthy: true }, hasGithub: true, hasBeads: true }} tab="feed" />);

    expect(await screen.findByText("Initial issue")).toBeInTheDocument();
    expect(wsHandler).toBeTypeOf("function");

    act(() => {
      wsHandler?.({
        type: "event",
        channel: "beads:changes",
        event: "beads:issue.upsert",
        data: { projectId: project.id, issue: { ...issue, id: "GB-2", title: "Live issue" } },
      });
    });

    expect(await screen.findByText("Live issue")).toBeInTheDocument();
  });

  it("moves an issue from open to closed on a realtime close event", async () => {
    render(<BeadsRepoView repo={{ fullName: "owner/repo-a", displayName: "repo-a", lastActivityAt: null, openBeadsCount: 1, githubStats: { openPRs: 0, commitsToday: 0, openIssues: 0, releases: 0 }, beadsStats: { open: 1, inProgress: 0, blocked: 0, epics: 0 }, beadsSource: { label: "dolt", title: "Beads reading from Dolt", healthy: true }, hasGithub: true, hasBeads: true }} tab="feed" />);

    expect(await screen.findByText("Initial issue")).toBeInTheDocument();
    expect(screen.getByLabelText("open issues")).toHaveTextContent("Initial issue");
    expect(screen.getByLabelText("closed issues")).not.toHaveTextContent("Initial issue");

    act(() => {
      wsHandler?.({
        type: "event",
        channel: "beads:changes",
        event: "beads:issue.close",
        data: { projectId: project.id, issueId: issue.id },
      });
    });

    expect(screen.getByLabelText("open issues")).not.toHaveTextContent("Initial issue");
    expect(screen.getByLabelText("closed issues")).toHaveTextContent("Initial issue");
  });

  it("reloads mounted data on sync hints", async () => {
    const listIssues = vi.spyOn(beadsApi, "listIssues")
      .mockResolvedValueOnce([issue])
      .mockResolvedValueOnce([{ ...issue, id: "GB-3", title: "Reloaded issue" }]);

    render(<BeadsRepoView repo={{ fullName: "owner/repo-a", displayName: "repo-a", lastActivityAt: null, openBeadsCount: 1, githubStats: { openPRs: 0, commitsToday: 0, openIssues: 0, releases: 0 }, beadsStats: { open: 1, inProgress: 0, blocked: 0, epics: 0 }, beadsSource: { label: "dolt", title: "Beads reading from Dolt", healthy: true }, hasGithub: true, hasBeads: true }} tab="feed" />);

    expect(await screen.findByText("Initial issue")).toBeInTheDocument();
    act(() => {
      wsHandler?.({ type: "event", channel: "beads:changes", event: "beads:sync_hint", data: { project_id: project.id, reason: "buffer_miss" } });
    });

    await waitFor(() => expect(listIssues).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Reloaded issue")).toBeInTheDocument();
  });
});
