import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StatsHeader } from "../../../../src/dashboard/components/github/StatsHeader.tsx";
import type { Summary } from "../../../../src/types/github.ts";

const summary: Summary = { events: 20, pushes: 8, prs: 4, commits: 30, repos: 5 };

describe("StatsHeader", () => {
  it("renders push count", () => {
    const html = renderToStaticMarkup(<StatsHeader summary={summary} />);
    expect(html).toContain(">8<");
  });

  it("renders pr count", () => {
    const html = renderToStaticMarkup(<StatsHeader summary={summary} />);
    expect(html).toContain(">4<");
  });

  it("renders repo count", () => {
    const html = renderToStaticMarkup(<StatsHeader summary={summary} />);
    expect(html).toContain(">5<");
  });

  it("renders labels", () => {
    const html = renderToStaticMarkup(<StatsHeader summary={summary} />);
    expect(html).toContain("Pushes");
    expect(html).toContain("PRs");
    expect(html).toContain("Repos");
  });

  it("renders dashes when summary is null", () => {
    const html = renderToStaticMarkup(<StatsHeader summary={null} />);
    const dashCount = (html.match(/>—</g) ?? []).length;
    expect(dashCount).toBe(5);
  });

  it("renders as single-line bar (no column flex layout)", () => {
    const html = renderToStaticMarkup(<StatsHeader summary={summary} />);
    expect(html).not.toContain("flex-direction:column");
  });

  it("renders commit octicon", () => {
    const html = renderToStaticMarkup(<StatsHeader summary={summary} />);
    expect(html).toContain("octicon-git-commit");
  });

  it("renders pull-request octicon", () => {
    const html = renderToStaticMarkup(<StatsHeader summary={summary} />);
    expect(html).toContain("octicon-git-pull-request");
  });

  it("renders repo octicon", () => {
    const html = renderToStaticMarkup(<StatsHeader summary={summary} />);
    expect(html).toContain("octicon-repo");
  });
});
