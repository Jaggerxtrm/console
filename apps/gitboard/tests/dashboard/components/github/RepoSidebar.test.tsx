// @vitest-environment node
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RepoSidebar } from "../../../../src/dashboard/components/github/RepoSidebar.tsx";

const repos = [
  { full_name: "owner/api", display_name: "api", tracked: true, group_name: "mercury", last_polled_at: null, color: "#6366f1" },
  { full_name: "owner/worker", display_name: null, tracked: true, group_name: "mercury", last_polled_at: null, color: null },
  { full_name: "owner/infra", display_name: "infra", tracked: true, group_name: "infra", last_polled_at: null, color: null },
];

const stats = {
  "owner/api": { full_name: "owner/api", pushes: 12, prs_open: 2, prs_closed: 3 },
};

const noop = () => {};

describe("RepoSidebar", () => {
  it("renders All Activity", () => {
    const html = renderToStaticMarkup(
      <RepoSidebar repos={repos} stats={stats} selectedRepos={[]} onSelect={noop} onReset={noop} />
    );
    expect(html).toContain("Repos");
  });

  it("renders display_name for repos that have it", () => {
    const html = renderToStaticMarkup(
      <RepoSidebar repos={repos} stats={stats} selectedRepos={[]} onSelect={noop} onReset={noop} />
    );
    expect(html).toContain("api");
    expect(html).toContain("infra");
  });

  it("falls back to repo slug when display_name is null", () => {
    const html = renderToStaticMarkup(
      <RepoSidebar repos={repos} stats={stats} selectedRepos={[]} onSelect={noop} onReset={noop} />
    );
    expect(html).toContain("worker");
  });

  it("renders push count from stats", () => {
    const html = renderToStaticMarkup(
      <RepoSidebar repos={repos} stats={stats} selectedRepos={[]} onSelect={noop} onReset={noop} />
    );
    expect(html).toContain("12");
  });

  it("renders prs_open count from stats", () => {
    const html = renderToStaticMarkup(
      <RepoSidebar repos={repos} stats={stats} selectedRepos={[]} onSelect={noop} onReset={noop} />
    );
    expect(html).toContain("2");
  });

  it("renders MERCURY and INFRA group headers", () => {
    const html = renderToStaticMarkup(
      <RepoSidebar repos={repos} stats={stats} selectedRepos={[]} onSelect={noop} onReset={noop} />
    );
    expect(html.toUpperCase()).toContain("MERCURY");
    expect(html.toUpperCase()).toContain("INFRA");
  });

  it("renders github.com links for each repo", () => {
    const html = renderToStaticMarkup(
      <RepoSidebar repos={repos} stats={stats} selectedRepos={[]} onSelect={noop} onReset={noop} />
    );
    expect(html).toContain("https://github.com/owner/api");
    expect(html).toContain("https://github.com/owner/worker");
    expect(html).toContain("https://github.com/owner/infra");
  });

  it("aria-pressed true for selected repo", () => {
    const html = renderToStaticMarkup(
      <RepoSidebar repos={repos} stats={stats} selectedRepos={["owner/api"]} onSelect={noop} onReset={noop} />
    );
    // The selected repo button should have aria-pressed="true"
    expect(html).toContain('aria-pressed="true"');
  });

  it("aria-pressed false for unselected repo", () => {
    const html = renderToStaticMarkup(
      <RepoSidebar repos={repos} stats={stats} selectedRepos={["owner/api"]} onSelect={noop} onReset={noop} />
    );
    expect(html).toContain('aria-pressed="false"');
  });

  it("shows no activity text for repos with no stats entry", () => {
    const html = renderToStaticMarkup(
      <RepoSidebar repos={repos} stats={stats} selectedRepos={[]} onSelect={noop} onReset={noop} />
    );
    expect(html).toContain("no activity today");
  });

  it("renders Select an event placeholder in sidebar when selectedEvent is null", () => {
    const html = renderToStaticMarkup(
      <RepoSidebar repos={repos} stats={stats} selectedRepos={[]} onSelect={noop} onReset={noop}
        selectedEvent={null} selectedEventCommits={[]} />
    );
    expect(html.toLowerCase()).toContain("select an event");
  });

  it("renders event title in sidebar when selectedEvent is provided", () => {
    const evt = {
      id: "evt-1", type: "PushEvent", repo: "owner/api", branch: "main",
      actor: "user1", action: null, title: "Push to main", body: null,
      url: "https://github.com/owner/api/commit/abc",
      additions: 10, deletions: 2, changed_files: 3, commit_count: 1,
      created_at: new Date().toISOString(),
    } as import("../../../../src/types/github.ts").GithubEvent;
    const html = renderToStaticMarkup(
      <RepoSidebar repos={repos} stats={stats} selectedRepos={[]} onSelect={noop} onReset={noop}
        selectedEvent={evt} selectedEventCommits={[]} />
    );
    expect(html).toContain("Push to main");
  });
});

// ─── T5: Repo sidebar own repos only, sorted by last activity ────────────────
import { filterOwnRepos, sortByLastEvent, relativeTime } from "../../../../src/dashboard/components/github/RepoSidebar.tsx";

const r = (full_name: string, last_polled_at: string | null = null) =>
  ({ full_name, display_name: null, tracked: true, group_name: null, last_polled_at, color: null });

describe("T5: filterOwnRepos", () => {
  it("returns all repos when lastEventAt is empty (no events yet)", () => {
    const repos = [r("owner/api"), r("owner/worker")];
    expect(filterOwnRepos(repos, {})).toHaveLength(2);
  });

  it("keeps only repos that appear in lastEventAt", () => {
    const repos = [r("owner/api"), r("owner/worker"), r("watcher/other")];
    const lastEventAt = { "owner/api": "2026-03-07T10:00:00Z", "owner/worker": "2026-03-07T09:00:00Z" };
    const result = filterOwnRepos(repos, lastEventAt);
    expect(result.map(x => x.full_name)).toEqual(["owner/api", "owner/worker"]);
  });

  it("excludes repos not in lastEventAt when events exist", () => {
    const repos = [r("owner/api"), r("watcher/other")];
    const lastEventAt = { "owner/api": "2026-03-07T10:00:00Z" };
    expect(filterOwnRepos(repos, lastEventAt)).toHaveLength(1);
    expect(filterOwnRepos(repos, lastEventAt)[0].full_name).toBe("owner/api");
  });
});

describe("T5: sortByLastEvent", () => {
  it("sorts repos with most recent event first", () => {
    const repos = [r("owner/old"), r("owner/new")];
    const lastEventAt = {
      "owner/old": "2026-03-06T10:00:00Z",
      "owner/new": "2026-03-07T10:00:00Z",
    };
    const sorted = sortByLastEvent(repos, lastEventAt);
    expect(sorted[0].full_name).toBe("owner/new");
    expect(sorted[1].full_name).toBe("owner/old");
  });

  it("repos without lastEventAt fall back to last_polled_at", () => {
    const repos = [r("owner/fallback", "2026-03-05T10:00:00Z"), r("owner/new")];
    const lastEventAt = { "owner/new": "2026-03-07T10:00:00Z" };
    const sorted = sortByLastEvent(repos, lastEventAt);
    expect(sorted[0].full_name).toBe("owner/new");
  });

  it("repos with no time data sort last", () => {
    const repos = [r("owner/notime"), r("owner/api")];
    const lastEventAt = { "owner/api": "2026-03-07T10:00:00Z" };
    const sorted = sortByLastEvent(repos, lastEventAt);
    expect(sorted[sorted.length - 1].full_name).toBe("owner/notime");
  });
});

describe("T5: relativeTime", () => {
  it("formats under 60 min as Xm ago", () => {
    const ago30 = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    expect(relativeTime(ago30)).toBe("30m ago");
  });

  it("formats 1-23 hours as Xh ago", () => {
    const ago5h = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
    expect(relativeTime(ago5h)).toBe("5h ago");
  });

  it("formats exactly 1 day ago as yesterday", () => {
    const ago1d = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    expect(relativeTime(ago1d)).toBe("yesterday");
  });

  it("formats 2+ days as Xd ago", () => {
    const ago3d = new Date(Date.now() - 3 * 86400 * 1000).toISOString();
    expect(relativeTime(ago3d)).toBe("3d ago");
  });
});
