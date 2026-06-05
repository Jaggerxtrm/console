import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type FeedSource = "specialists" | "beads" | "github" | "materializer";

interface FeedRow {
  id: string;
  source: FeedSource;
  kind: string;
  repo_slug: string;
  title: string;
  summary: string;
  t_unix_ms: number;
  seq: number;
  severity: "debug" | "info" | "warn" | "error";
  status: string;
  redaction_status: "clean" | "redacted";
  drilldown: {
    job_id?: string;
    issue_id?: string;
    github_event_id?: string;
    forensic_event_ids?: number[];
    evidence_ids?: string[];
  };
}

interface FeedFixture {
  endpoint: string;
  cursor: { limit: number; next: string | null };
  rows: FeedRow[];
}

const here = dirname(fileURLToPath(import.meta.url));

function loadFixture(): FeedFixture {
  return JSON.parse(readFileSync(join(here, "../fixtures/api-feed-rollup-contract.json"), "utf8")) as FeedFixture;
}

describe("/api/feed rollup contract fixture", () => {
  it("defines a cursor-paginated rollup ordered by (t_unix_ms, seq)", () => {
    const fixture = loadFixture();
    expect(fixture.endpoint).toBe("/api/feed");
    expect(fixture.cursor.limit).toBeGreaterThan(0);
    expect(typeof fixture.cursor.next).toBe("string");

    const ordered = [...fixture.rows].sort((a, b) => a.t_unix_ms - b.t_unix_ms || a.seq - b.seq);
    expect(fixture.rows).toEqual(ordered);
  });

  it("covers specialists, beads, GitHub, and malformed-source tolerance", () => {
    const fixture = loadFixture();
    expect(new Set(fixture.rows.map((row) => row.source))).toEqual(new Set(["specialists", "beads", "github", "materializer"]));
    expect(fixture.rows.some((row) => row.kind === "malformed_source_row" && row.severity === "warn")).toBe(true);
  });

  it("is a display rollup with drilldown pointers, not a raw forensic envelope", () => {
    const fixture = loadFixture();
    for (const row of fixture.rows) {
      expect(row.title.trim()).not.toBe("");
      expect(row.summary.trim()).not.toBe("");
      expect(row.drilldown).toBeTruthy();
      expect(row).not.toHaveProperty("body");
      expect(row).not.toHaveProperty("correlation");
      expect(row).not.toHaveProperty("trace");
      expect(row).not.toHaveProperty("links");
      expect(row).not.toHaveProperty("envelope");
    }
  });
});
