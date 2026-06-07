import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const itWithBunSqlite = "Bun" in globalThis ? it : it.skip;

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("core state database schema", () => {
  itWithBunSqlite("creates the xtrm runtime tables from the core state package", async () => {
    const { createXtrmDatabase, XTRM_TABLES } = await import("../src/state/database.ts");
    const root = mkdtempSync(join(tmpdir(), "core-state-db-"));
    tempDirs.push(root);
    const db = createXtrmDatabase(join(root, "xtrm.sqlite"));

    for (const table of XTRM_TABLES) {
      const row = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { name: string } | undefined;
      expect(row?.name).toBe(table);
    }
  });

  itWithBunSqlite("keeps additive migrations idempotent", async () => {
    const { createXtrmDatabase } = await import("../src/state/database.ts");
    const root = mkdtempSync(join(tmpdir(), "core-state-db-idempotent-"));
    tempDirs.push(root);
    const dbPath = join(root, "xtrm.sqlite");

    createXtrmDatabase(dbPath).close();
    const db = createXtrmDatabase(dbPath);

    const specialistColumns = new Set((db.query("PRAGMA table_info(specialist_jobs)").all() as Array<{ name: string }>).map((column) => column.name));
    expect(specialistColumns).toContain("bead_id");
    expect(specialistColumns).toContain("updated_at_ms");

    const issueColumns = new Set((db.query("PRAGMA table_info(substrate_issues)").all() as Array<{ name: string }>).map((column) => column.name));
    expect(issueColumns).toContain("runtime_kind");
    expect(issueColumns).toContain("metadata_json");
  });
});
