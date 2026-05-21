import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");

const requiredBoundaryCases = [
  {
    file: "apps/beadboard/tests/api/routes/beads-routes.test.ts",
    titles: [
      "routes /issues/closed to the closed-list handler before issue detail",
    ],
  },
  {
    file: "apps/beadboard/tests/core/dolt-client-runtime.test.ts",
    titles: [
      "keeps same-port databases in separate runtime keys",
      "opens breaker for one pool key without blocking another pool key",
    ],
  },
  {
    file: "apps/gitboard/tests/api/routes/graph.test.ts",
    titles: [
      "reuses cached scan and issue data until explicit refresh",
      "does not reuse an in-flight scan for explicit refresh",
      "keeps unrelated project issue caches warm on project-scoped refresh",
    ],
  },
  {
    file: "apps/gitboard/tests/api/routes/github-detail-cache.test.ts",
    titles: [
      "returns partial detail with section errors when one GitHub segment times out",
      "lists report entries without fetching every report body for frontmatter",
    ],
  },
  {
    file: "apps/gitboard/tests/core/github-poller-loop.test.ts",
    titles: [
      "paginates repo prs/issues and publishes upserts",
      "processes due repos with bounded concurrency instead of sleeping between repos",
      "records poll time separately from latest activity so quiet repos are not immediately due again",
      "does not record poll time when GitHub requests fail",
      "persists ETags and reuses them on the next due poll",
      "respects Retry-After rate-limit pauses",
      "keeps the longest rate-limit pause under concurrent responses",
    ],
  },
  {
    file: "apps/gitboard/tests/api/routes/specialists.test.ts",
    titles: [
      "reuses cached live summaries until repo epoch changes",
      "returns 200 with healthy data when one attached db is corrupt (skips bad repo)",
    ],
  },
] as const;

describe("forge-ojn4 backend performance boundary regression coverage", () => {
  for (const boundary of requiredBoundaryCases) {
    it(`${boundary.file} keeps required runnable boundary cases`, () => {
      const source = readFileSync(resolve(root, boundary.file), "utf8");
      const runnableTitles = extractRunnableTestTitles(source);

      for (const title of boundary.titles) {
        expect(runnableTitles).toContain(title);
      }
    });
  }
});

function extractRunnableTestTitles(source: string): string[] {
  const titles: string[] = [];
  const declaration = /\b(?:describe|it|test)(?:\.only|\.concurrent)?\s*\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g;
  let match: RegExpExecArray | null;

  while ((match = declaration.exec(source)) !== null) {
    titles.push(match[2]!.replace(/\\(["'`])/g, "$1"));
  }

  return titles;
}
