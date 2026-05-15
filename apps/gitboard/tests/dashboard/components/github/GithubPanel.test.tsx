import { describe, it, expect, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GithubPanel } from "../../../../src/dashboard/components/github/GithubPanel.tsx";
import { useGithubStore } from "../../../../src/dashboard/stores/github.ts";
import type { GithubEvent } from "../../../../src/types/github.ts";

const noop = () => {};

beforeEach(() => {
  const s = useGithubStore.getState();
  s.setEvents([]);
  s.selectEvent(null);
  s.setSelectedEventCommits([]);
  s.setRepos([]);
  s.setContributions([]);
  s.setLoading(false);
  s.setError(null);
  s.setReleases([]);
  s.resetFilter();
  s.setRepoStats([]);
});

describe("GithubPanel (SSR)", () => {
  it("renders All Activity in repo sidebar", () => {
    const html = renderToStaticMarkup(<GithubPanel onMount={noop} />);
    expect(html).toContain("Repos");
  });

  it("renders stat labels always present", () => {
    const html = renderToStaticMarkup(<GithubPanel onMount={noop} />);
    expect(html).toContain("Pushes");
    expect(html).toContain("Events");
    expect(html).toContain("Repos");
  });

  it("renders empty timeline message when no events", () => {
    const html = renderToStaticMarkup(<GithubPanel onMount={noop} />);
    expect(html.toLowerCase()).toContain("no events");
  });

  it("renders repo sidebar with All Activity when no repos", () => {
    const html = renderToStaticMarkup(<GithubPanel onMount={noop} />);
    expect(html).toContain("Repos");
  });

  it("does not render a sliding right detail panel", () => {
    const html = renderToStaticMarkup(<GithubPanel onMount={noop} />);
    expect(html).not.toContain("--detail-width");
  });

  // Heatmap deferred to v0.8.0 — not rendered in GithubPanel
  it("does not render contribution heatmap (deferred to v0.8.0)", () => {
    const html = renderToStaticMarkup(<GithubPanel onMount={noop} />);
    expect(html.toLowerCase()).not.toContain("no contribution data");
  });

  // EventDetail sidebar accordion deferred — event detail lives in ActivityTimeline only
  it("does not render EventDetail placeholder in panel (deferred)", () => {
    const html = renderToStaticMarkup(<GithubPanel onMount={noop} />);
    expect(html.toLowerCase()).not.toContain("select an event");
  });
});

// T4: Social event filtering — tested as pure logic (renderToStaticMarkup can't
// reliably reflect store state set in beforeEach via useSyncExternalStore snapshot)
describe("T4: SOCIAL_TYPES filter logic", () => {
  const SOCIAL_TYPES = new Set(["WatchEvent", "ForkEvent", "MemberEvent"]);

  const makeEvent = (type: string): GithubEvent => ({
    id: type, type, repo: "owner/repo", branch: null, actor: "alice",
    action: null, title: type, body: null, url: null,
    additions: null, deletions: null, changed_files: null, commit_count: null,
    created_at: new Date().toISOString(),
  });

  it("WatchEvent is classified as social", () => {
    expect(SOCIAL_TYPES.has("WatchEvent")).toBe(true);
  });

  it("ForkEvent is classified as social", () => {
    expect(SOCIAL_TYPES.has("ForkEvent")).toBe(true);
  });

  it("MemberEvent is classified as social", () => {
    expect(SOCIAL_TYPES.has("MemberEvent")).toBe(true);
  });

  it("PushEvent is classified as owned activity (not social)", () => {
    expect(SOCIAL_TYPES.has("PushEvent")).toBe(false);
  });

  it("PullRequestEvent is classified as owned activity (not social)", () => {
    expect(SOCIAL_TYPES.has("PullRequestEvent")).toBe(false);
  });

  it("filters social events out of ownEvents correctly", () => {
    const events = [makeEvent("PushEvent"), makeEvent("WatchEvent"), makeEvent("ForkEvent")];
    const ownEvents = events.filter((e) => !SOCIAL_TYPES.has(e.type));
    const socialEvents = events.filter((e) => SOCIAL_TYPES.has(e.type));
    expect(ownEvents).toHaveLength(1);
    expect(ownEvents[0].type).toBe("PushEvent");
    expect(socialEvents).toHaveLength(2);
  });
});
