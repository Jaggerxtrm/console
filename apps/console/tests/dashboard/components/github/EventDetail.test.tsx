// @vitest-environment node
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EventDetail } from "../../../../src/dashboard/components/github/EventDetail.tsx";
import type { GithubEvent, GithubCommit } from "../../../../src/types/github.ts";

const makeEvent = (overrides: Partial<GithubEvent> = {}): GithubEvent => ({
  id: "evt-1",
  type: "PushEvent",
  repo: "owner/api",
  branch: "main",
  actor: "user1",
  action: null,
  title: "Push to main",
  body: null,
  url: "https://github.com/owner/api/commit/abc",
  additions: 10,
  deletions: 2,
  changed_files: 3,
  commit_count: 1,
  created_at: new Date().toISOString(),
  ...overrides,
});

const makeCommit = (overrides: Partial<GithubCommit> = {}): GithubCommit => ({
  sha: "abc1234567890",
  repo: "owner/api",
  branch: "main",
  author: "user1",
  message: "fix: correct bug",
  message_full: null,
  url: "https://github.com/owner/api/commit/abc1234567890",
  additions: null,
  deletions: null,
  changed_files: null,
  event_id: "evt-1",
  committed_at: new Date().toISOString(),
  ...overrides,
});

describe("EventDetail", () => {
  it("renders empty state when event is null", () => {
    const html = renderToStaticMarkup(<EventDetail event={null} commits={[]} />);
    expect(html).toContain("Select an event to see details");
  });

  it("renders event title", () => {
    const html = renderToStaticMarkup(<EventDetail event={makeEvent()} commits={[]} />);
    expect(html).toContain("Push to main");
  });

  it("renders repo and branch in header", () => {
    const html = renderToStaticMarkup(<EventDetail event={makeEvent()} commits={[]} />);
    expect(html).toContain("owner/api");
    expect(html).toContain("main");
  });

  it("renders additions in output when additions non-null", () => {
    const html = renderToStaticMarkup(<EventDetail event={makeEvent({ additions: 10 })} commits={[]} />);
    expect(html).toContain("+10");
  });

  it("renders deletions in output when deletions non-null", () => {
    const html = renderToStaticMarkup(<EventDetail event={makeEvent({ deletions: 2 })} commits={[]} />);
    expect(html).toContain("−2");
  });

  it("does not render diffstat bar when additions and deletions are null", () => {
    const html = renderToStaticMarkup(<EventDetail event={makeEvent({ additions: null, deletions: null })} commits={[]} />);
    expect(html).not.toContain("var(--diff-add)");
    expect(html).not.toContain("var(--diff-del)");
  });

  it("renders commit SHAs as first 7 chars", () => {
    const html = renderToStaticMarkup(<EventDetail event={makeEvent()} commits={[makeCommit()]} />);
    expect(html).toContain("abc1234");
  });

  it("renders commit message subject lines", () => {
    const html = renderToStaticMarkup(<EventDetail event={makeEvent()} commits={[makeCommit()]} />);
    expect(html).toContain("fix: correct bug");
  });

  it("renders View on GitHub link when event.url present", () => {
    const html = renderToStaticMarkup(<EventDetail event={makeEvent()} commits={[]} />);
    expect(html).toContain("View on GitHub");
    expect(html).toContain("https://github.com/owner/api/commit/abc");
  });

  it("renders event.body content when non-null", () => {
    const html = renderToStaticMarkup(<EventDetail event={makeEvent({ body: "This is the PR description" })} commits={[]} />);
    expect(html).toContain("This is the PR description");
  });

  it("does not render body section when event.body is null", () => {
    const html = renderToStaticMarkup(<EventDetail event={makeEvent({ body: null })} commits={[]} />);
    // body section uses border-left with event color — should not appear
    expect(html).not.toContain("border-left:3px solid");
  });
});
