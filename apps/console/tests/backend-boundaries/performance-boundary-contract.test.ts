import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");

const requiredBoundaryCases = [
  {
    file: "apps/console/tests/server/routes/substrate.test.ts",
    titles: [
      "orders closed issues by most recent close timestamp before applying the limit",
    ],
  },
  {
    file: "packages/core/tests/materializer/beads-adapter.retired-host-contract.test.ts",
    titles: [
      "delegates snapshot + diff and materializer advances cursor only on success",
      "preserves Beads runtime graph semantics for pre-Substrate chains",
    ],
  },
  {
    file: "apps/console/tests/server/routes/graph.xtrm.test.ts",
    titles: [
      "surfaces xtrm graph health without letting GET refresh trigger materializer",
      "keeps invalidate cooldown state isolated per router instance",
      "rejects invalid invalidate project keys",
    ],
  },
  {
    file: "apps/console/tests/server/routes/github-detail-cache.test.ts",
    titles: [
      "returns partial detail with section errors when one GitHub segment times out",
      "lists report entries without fetching every report body for frontmatter",
    ],
  },
  {
    file: "packages/core/tests/github/poller-loop.retired-host-contract.test.ts",
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
    file: "apps/console/tests/server/routes/specialists.test.ts",
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
