// @vitest-environment node
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReleaseTimeline } from "../../../../src/dashboard/components/github/ReleaseTimeline.tsx";
import type { GithubRelease } from "../../../../src/types/github.ts";

const release: GithubRelease = {
  id: "rel-1",
  tag_name: "v1.2.3",
  name: "v1.2.3",
  body: "Release notes\n\n- Fix bug\n- Ship feature",
  html_url: "https://github.com/owner/repo/releases/tag/v1.2.3",
  author_login: "alice",
  published_at: "2026-03-06T15:41:00Z",
  repo_full_name: "owner/repo",
};

describe("ReleaseTimeline (SSR)", () => {
  it("renders empty state", () => {
    const html = renderToStaticMarkup(<ReleaseTimeline releases={[]} />);
    expect(html.toLowerCase()).toContain("no releases");
  });

  it("renders one release row", () => {
    const html = renderToStaticMarkup(<ReleaseTimeline releases={[release]} />);
    expect(html).toContain("v1.2.3");
    expect(html).toContain("owner/repo");
    expect(html).toContain("alice");
  });

  it("renders release body via renderPrBodyText path", () => {
    const html = renderToStaticMarkup(<ReleaseTimeline releases={[release]} />);
    expect(html).toContain("Release notes");
    expect(html).toContain("Fix bug");
  });
});
