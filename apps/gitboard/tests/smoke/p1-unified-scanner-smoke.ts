import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createXtrmDatabase } from "../../src/core/xtrm-store.ts";
import { UnifiedScanner } from "../../src/core/unified-scanner.ts";

async function main(): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), "gitboard-unified-scanner-smoke-"));
  const dbPath = join(tmpDir, "xtrm.sqlite");
  const repoDir = join(tmpDir, "repo");

  try {
    mkdirSync(join(repoDir, ".beads"), { recursive: true });
    writeFileSync(join(repoDir, ".beads", "metadata.json"), JSON.stringify({ project_id: "smoke-project" }));

    const db = createXtrmDatabase(dbPath);
    const scanner = new UnifiedScanner(db, { beadsSearchPath: tmpDir, observabilityRoots: [tmpDir], refreshIntervalMs: 50, parityEnabled: false });
    scanner.start();

    let rowCount = 0;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const row = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM sources WHERE source_key = 'beads:smoke-project'").get();
      rowCount = row?.c ?? 0;
      if (rowCount === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (rowCount !== 1) throw new Error("scanner timer did not trigger refresh");

    await scanner.stop();
    db.close();
    console.log("scanner timer smoke ok");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
