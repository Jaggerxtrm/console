// @vitest-environment node
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityTimeline } from "../../../../src/dashboard/components/github/ActivityTimeline.tsx";
import type { GithubEvent } from "../../../../src/types/github.ts";

const events: GithubEvent[] = [
  {
    id: "e1",
    type: "PushEvent",
    repo: "owner/repo-a",
    branch: "main",
    actor: "alice",
    action: null,
    title: "fix: bug fix",
    body: null,
    url: null,
    additions: 10,
    deletions: 2,
    changed_files: 1,
    commit_count: 2,
    created_at: "2026-03-06T15:41:00Z",
  },
  {
    id: "e2",
    type: "PullRequestEvent",
    repo: "owner/repo-b",
    branch: null,
    actor: "bob",
    action: "merged",
    title: "feat: new feature",
    body: null,
    url: null,
    additions: null,
    deletions: null,
    changed_files: null,
    commit_count: null,
    created_at: "2026-03-06T15:38:00Z",
  },
];

describe("ActivityTimeline (SSR)", () => {
  it("renders empty state when no events", () => {
    const html = renderToStaticMarkup(
      <ActivityTimeline events={[]} selectedId={null} onSelect={() => {}} />
    );
    expect(html.toLowerCase()).toContain("no events");
  });

  it("renders event titles in SSR fallback", () => {
    const html = renderToStaticMarkup(
      <ActivityTimeline events={events} selectedId={null} onSelect={() => {}} />
    );
    expect(html).toContain("fix: bug fix");
    expect(html).toContain("feat: new feature");
  });

  it("renders repo names in SSR fallback", () => {
    const html = renderToStaticMarkup(
      <ActivityTimeline events={events} selectedId={null} onSelect={() => {}} />
    );
    expect(html).toContain("owner/repo-a");
    expect(html).toContain("owner/repo-b");
  });

  it("marks selected event row with aria-selected=true", () => {
    const html = renderToStaticMarkup(
      <ActivityTimeline events={events} selectedId="e1" onSelect={() => {}} />
    );
    expect(html).toContain('aria-selected="true"');
  });

  it("non-selected rows have aria-selected=false", () => {
    const html = renderToStaticMarkup(
      <ActivityTimeline events={events} selectedId="e1" onSelect={() => {}} />
    );
    expect(html).toContain('aria-selected="false"');
  });

  it("renders commit count when present", () => {
    const html = renderToStaticMarkup(
      <ActivityTimeline events={events} selectedId={null} onSelect={() => {}} />
    );
    expect(html).toContain("2 commits");
  });
});

describe("ActivityTimeline — new SSR features", () => {
  const now = new Date().toISOString();

  const todayPushEvent: GithubEvent = {
    id: "push-today",
    type: "PushEvent",
    repo: "owner/api",
    branch: "feat/new-thing",
    actor: "alice",
    action: null,
    title: "Push today",
    body: null,
    url: null,
    additions: 10,
    deletions: 2,
    changed_files: 3,
    commit_count: 1,
    created_at: now,
  };

  const prEvent: GithubEvent = {
    id: "pr-today",
    type: "PullRequestEvent",
    repo: "owner/api",
    branch: null,
    actor: "bob",
    action: "opened",
    title: "PR opened",
    body: null,
    url: null,
    additions: null,
    deletions: null,
    changed_files: null,
    commit_count: null,
    created_at: now,
  };

  it("renders +10 additions inline for PushEvent", () => {
    const html = renderToStaticMarkup(
      <ActivityTimeline events={[todayPushEvent]} selectedId={null} onSelect={() => {}} />
    );
    expect(html).toContain("+10");
  });

  it("renders −2 deletions inline for PushEvent", () => {
    const html = renderToStaticMarkup(
      <ActivityTimeline events={[todayPushEvent]} selectedId={null} onSelect={() => {}} />
    );
    expect(html).toContain("−2");
  });

  it("does not render diffstat markup when additions/deletions are null", () => {
    const html = renderToStaticMarkup(
      <ActivityTimeline events={[prEvent]} selectedId={null} onSelect={() => {}} />
    );
    expect(html).not.toContain("var(--diff-add)");
    expect(html).not.toContain("var(--diff-del)");
  });

  it("renders day group header Today when events are from today", () => {
    const html = renderToStaticMarkup(
      <ActivityTimeline events={[todayPushEvent]} selectedId={null} onSelect={() => {}} />
    );
    expect(html).toContain("Today");
  });

  it("renders branch name in event row when branch is non-null", () => {
    const html = renderToStaticMarkup(
      <ActivityTimeline events={[todayPushEvent]} selectedId={null} onSelect={() => {}} />
    );
    expect(html).toContain("feat/new-thing");
  });

  it("chevron toggle rendered for PushEvents in SSR", () => {
    const html = renderToStaticMarkup(
      <ActivityTimeline events={[todayPushEvent]} selectedId={null} onSelect={() => {}} />
    );
    expect(html).toContain("octicon-chevron-down");
  });

  it("no chevron rendered for non-PushEvents", () => {
    const html = renderToStaticMarkup(
      <ActivityTimeline events={[prEvent]} selectedId={null} onSelect={() => {}} />
    );
    expect(html).not.toContain("octicon-chevron-down");
  });
});

// ─── T7: Inline commit accordion ─────────────────────────────────────────────
import { commitBodyLines, COMMIT_BODY_SOFT_CAP } from "../../../../src/dashboard/components/github/ActivityTimeline.tsx";

describe("T7: commitBodyLines", () => {
  it("returns empty array when message_full is null", () => {
    expect(commitBodyLines(null)).toEqual([]);
  });

  it("returns empty array when message_full has no body (subject only)", () => {
    expect(commitBodyLines("fix: typo")).toEqual([]);
  });

  it("returns body lines after blank separator", () => {
    const full = "fix: typo\n\nThis fixes the issue\nwith more detail";
    expect(commitBodyLines(full)).toEqual(["This fixes the issue", "with more detail"]);
  });

  it("trims leading blank separator line", () => {
    const full = "feat: add feature\n\n\nsome body";
    expect(commitBodyLines(full)).toEqual(["some body"]);
  });

  it("caps at COMMIT_BODY_SOFT_CAP lines", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const full = "subject\n\n" + lines.join("\n");
    const result = commitBodyLines(full);
    expect(result.length).toBeLessThanOrEqual(COMMIT_BODY_SOFT_CAP);
  });

  it("COMMIT_BODY_SOFT_CAP is 20", () => {
    expect(COMMIT_BODY_SOFT_CAP).toBe(20);
  });
});
