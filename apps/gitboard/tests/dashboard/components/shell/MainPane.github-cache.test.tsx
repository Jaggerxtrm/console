/** @vitest-environment happy-dom */

import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubEvent, GithubIssue, GithubPr, GithubRelease } from "../../../../src/types/github.ts";
import type { RepoNode } from "../../../../src/types/shell.ts";

const { apiClient } = vi.hoisted(() => ({
  apiClient: {
    getEvents: vi.fn(async () => ({ data: [] as GithubEvent[] })),
    getPrs: vi.fn(async () => ({ data: [] as GithubPr[] })),
    getIssues: vi.fn(async () => ({ data: [] as GithubIssue[] })),
    getReleases: vi.fn(async () => ({ releases: [] as GithubRelease[] })),
  },
}));

vi.mock("../../../../src/dashboard/lib/client.ts", () => ({ apiClient }));
vi.mock("../../../../src/dashboard/components/shell/BottomDrawer.tsx", () => ({ BottomDrawer: () => <div data-testid="bottom-drawer" /> }));
vi.mock("../../../../src/dashboard/pages/console/Graph.tsx", () => ({ Graph: () => <div data-testid="graph" /> }));
vi.mock("../../../../src/dashboard/pages/console/Observability.tsx", () => ({ Observability: () => <div data-testid="observability" /> }));
vi.mock("../../../../src/dashboard/pages/console/Specialists.tsx", () => ({ Specialists: () => <div data-testid="specialists" /> }));
vi.mock("../../../../src/dashboard/components/github/ActivityTimeline.tsx", () => ({
  ActivityTimeline: ({ events }: { events: GithubEvent[] }) => <div data-testid="activity">{events.map((event) => <span key={event.id}>{event.title}</span>)}</div>,
}));
vi.mock("../../../../src/dashboard/components/github/PrTimeline.tsx", () => ({
  PrTimeline: ({ prs }: { prs: GithubPr[] }) => <div data-testid="prs">{prs.map((pr) => <span key={`${pr.repo}#${pr.number}`}>{pr.title}</span>)}</div>,
}));
vi.mock("../../../../src/dashboard/components/github/IssueTimeline.tsx", () => ({
  IssueTimeline: ({ issues }: { issues: GithubIssue[] }) => <div data-testid="issues">{issues.map((issue) => <span key={`${issue.repo}#${issue.number}`}>{issue.title}</span>)}</div>,
}));
vi.mock("../../../../src/dashboard/components/github/ReleaseTimeline.tsx", () => ({
  ReleaseTimeline: ({ releases }: { releases: GithubRelease[] }) => <div data-testid="releases">{releases.map((release) => <span key={release.id}>{release.name ?? release.tag_name}</span>)}</div>,
}));
vi.mock("../../../../src/dashboard/components/github/RepoContentPanels.tsx", () => ({
  ReadmeView: () => <div>README</div>,
  ChangelogView: () => <div>CHANGELOG</div>,
  ReportsView: () => <div>Reports</div>,
}));

import { MainPane } from "../../../../src/dashboard/components/shell/MainPane.tsx";
import { useGithubStore } from "../../../../src/dashboard/stores/github.ts";
import { useShellStore } from "../../../../src/dashboard/stores/shell.ts";

const repo = (fullName: string): RepoNode => ({
  fullName,
  displayName: fullName.split("/")[1] ?? fullName,
  lastActivityAt: null,
  openBeadsCount: 0,
  githubStats: { openPRs: 0, commitsToday: 0, openIssues: 0, releases: 0 },
  beadsStats: { open: 0, inProgress: 0, blocked: 0, epics: 0 },
  beadsSource: null,
  hasGithub: true,
  hasBeads: false,
});

const event = (repoName: string, id = "event-1", title = "Repo event"): GithubEvent => ({
  id,
  repo: repoName,
  type: "PushEvent",
  branch: "main",
  actor: "alice",
  action: null,
  title,
  body: null,
  url: null,
  additions: 1,
  deletions: 0,
  changed_files: 1,
  commit_count: 1,
  created_at: "2026-05-20T10:00:00Z",
});

const pr = (repoName: string, title: string, updated_at: string): GithubPr => ({
  repo: repoName,
  number: 7,
  title,
  body: null,
  state: "open",
  author: "alice",
  url: null,
  additions: null,
  deletions: null,
  changed_files: null,
  comment_count: 0,
  label_names: null,
  created_at: "2026-05-20T09:00:00Z",
  updated_at,
  merged_at: null,
  closed_at: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  useGithubStore.setState({ events: [], selectedEvent: null, selectedEventCommits: [], repos: [], contributions: [], summary: null, filter: {}, loading: false, error: null, repoStats: {}, unreadRepos: new Set(), prs: [], issues: [], releases: [] });
});

describe("MainPane GitHub tab data loading", () => {
  it("loads only activity data for the activity tab", async () => {
    const fullName = "owner/activity-only";
    apiClient.getEvents.mockResolvedValueOnce({ data: [event(fullName)] });
    useShellStore.setState({ repos: [repo(fullName)], selection: { surface: "github", tab: "activity", repo: fullName } });

    render(<MainPane />);

    expect(await screen.findByText("Repo event")).toBeInTheDocument();
    expect(apiClient.getEvents).toHaveBeenCalledWith({ repos: [fullName], limit: 200 });
    expect(apiClient.getPrs).not.toHaveBeenCalled();
    expect(apiClient.getIssues).not.toHaveBeenCalled();
    expect(apiClient.getReleases).not.toHaveBeenCalled();
  });

  it("fetches only the newly selected tab data when switching tabs", async () => {
    const fullName = "owner/tab-switch";
    apiClient.getEvents.mockResolvedValueOnce({ data: [event(fullName, "event-2", "Activity first")] });
    apiClient.getPrs.mockResolvedValueOnce({ data: [pr(fullName, "PR loaded", "2026-05-20T11:00:00Z")] });
    useShellStore.setState({ repos: [repo(fullName)], selection: { surface: "github", tab: "activity", repo: fullName } });

    render(<MainPane />);
    expect(await screen.findByText("Activity first")).toBeInTheDocument();

    act(() => useShellStore.getState().setTab("prs"));

    expect(await screen.findByText("PR loaded")).toBeInTheDocument();
    expect(apiClient.getEvents).toHaveBeenCalledTimes(1);
    expect(apiClient.getPrs).toHaveBeenCalledWith({ repo: fullName, limit: 200 });
    expect(apiClient.getIssues).not.toHaveBeenCalled();
    expect(apiClient.getReleases).not.toHaveBeenCalled();
  });

  it("shows live PR upserts instantly when the PR tab has no HTTP data yet", async () => {
    const fullName = "owner/live-visible";
    let resolvePrs!: (value: { data: GithubPr[] }) => void;
    apiClient.getPrs.mockReturnValueOnce(new Promise((resolve) => { resolvePrs = resolve; }));
    useShellStore.setState({ repos: [repo(fullName)], selection: { surface: "github", tab: "prs", repo: fullName } });

    render(<MainPane />);
    expect(screen.getByText("Loading prs…")).toBeInTheDocument();

    act(() => {
      useGithubStore.getState().upsertPr(pr(fullName, "Instant WS PR", "2026-05-20T12:00:00Z"));
    });

    expect(await screen.findByText("Instant WS PR")).toBeInTheDocument();

    await act(async () => {
      resolvePrs({ data: [] });
    });
    expect(screen.getByText("Instant WS PR")).toBeInTheDocument();
  });

  it("keeps newer live PR data when a stale HTTP response resolves later", async () => {
    const fullName = "owner/live-pr";
    let resolvePrs!: (value: { data: GithubPr[] }) => void;
    apiClient.getPrs.mockReturnValueOnce(new Promise((resolve) => { resolvePrs = resolve; }));
    useShellStore.setState({ repos: [repo(fullName)], selection: { surface: "github", tab: "prs", repo: fullName } });

    render(<MainPane />);

    act(() => {
      useGithubStore.getState().upsertPr(pr(fullName, "Live PR", "2026-05-20T12:00:00Z"));
    });
    expect(await screen.findByText("Live PR")).toBeInTheDocument();

    await act(async () => {
      resolvePrs({ data: [pr(fullName, "Stale HTTP PR", "2026-05-20T10:00:00Z")] });
    });

    expect(screen.getByText("Live PR")).toBeInTheDocument();
    expect(screen.queryByText("Stale HTTP PR")).not.toBeInTheDocument();
  });
});
