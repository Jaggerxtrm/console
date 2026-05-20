import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");

const requiredBoundaryCases = [
  {
    file: "apps/beadboard/tests/api/routes/beads-routes.test.ts",
    patterns: [
      /routes \/issues\/closed to the closed-list handler before issue detail/,
      /expect\(getIssue\)\.not\.toHaveBeenCalled\(\)/,
    ],
  },
  {
    file: "apps/beadboard/tests/core/dolt-client-runtime.test.ts",
    patterns: [
      /keeps same-port databases in separate runtime keys/,
      /opens breaker for one pool key without blocking another pool key/,
    ],
  },
  {
    file: "apps/gitboard/tests/api/routes/graph.test.ts",
    patterns: [
      /reuses cached scan and issue data until explicit refresh/,
      /does not reuse an in-flight scan for explicit refresh/,
      /keeps unrelated project issue caches warm on project-scoped refresh/,
    ],
  },
  {
    file: "apps/gitboard/tests/api/routes/github-detail-cache.test.ts",
    patterns: [
      /returns partial detail with section errors when one GitHub segment times out/,
      /lists report entries without fetching every report body for frontmatter/,
    ],
  },
  {
    file: "apps/gitboard/tests/core/github-poller-loop.test.ts",
    patterns: [
      /paginates repo prs\/issues and publishes upserts/,
      /processes due repos with bounded concurrency instead of sleeping between repos/,
      /persists ETags and reuses them on the next due poll/,
      /respects Retry-After rate-limit pauses/,
    ],
  },
  {
    file: "apps/gitboard/tests/api/routes/specialists.test.ts",
    patterns: [
      /reuses cached live summaries until repo epoch changes/,
      /returns 200 with healthy data when one attached db is corrupt/,
    ],
  },
] as const;

describe("forge-ojn4 backend performance boundary regression coverage", () => {
  for (const boundary of requiredBoundaryCases) {
    it(`${boundary.file} keeps required boundary cases`, () => {
      const source = readFileSync(resolve(root, boundary.file), "utf8");
      for (const pattern of boundary.patterns) {
        expect(source).toMatch(pattern);
      }
    });
  }
});
