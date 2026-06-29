import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(process.cwd(), "../..");

describe("Datasette sidecar config", () => {
  it("defines ten bounded canned queries mapped to KPI and operator recipes", () => {
    const metadata = readFileSync(join(repoRoot, "tools/datasette/metadata.yml"), "utf8");
    const queryNames = [...metadata.matchAll(/^      "([^"]+)":$/gm)].map((match) => match[1]);

    expect(queryNames).toHaveLength(10);
    expect(queryNames.slice(0, 8).every((name) => name?.startsWith("Recipe "))).toBe(true);
    expect(queryNames).toContain("Open beads by repository and priority");
    expect(queryNames).toContain("Recent forensic event families");
    expect(metadata).not.toContain("datasette-write");
    expect(metadata).toContain("xtrm_forensic_events");
    expect(metadata).not.toContain("from forensic_events");
  });

  it("starts Datasette with normal read-only mount, base_url, and log capture", () => {
    const script = readFileSync(join(repoRoot, "tools/datasette/dev-datasette.ts"), "utf8");

    expect(script).not.toContain('"--immutable"');
    expect(script).toContain('"base_url"');
    expect(script).toContain('"/explore/sql/"');
    expect(script).toContain("logs/datasette.log");
    expect(script).toContain("xtrm.db");
  });
});
