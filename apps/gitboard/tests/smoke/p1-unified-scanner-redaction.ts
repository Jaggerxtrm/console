import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createXtrmDatabase } from "../../src/core/xtrm-store.ts";
import { getRing } from "../../src/core/logger.ts";
import { UnifiedScanner } from "../../src/core/unified-scanner.ts";

const root = mkdtempSync(join(tmpdir(), "gitboard-unified-scanner-redaction-smoke-"));
const db = createXtrmDatabase(join(root, "xtrm.sqlite"));

try {
  const repoDir = join(root, "repo");
  mkdirSync(join(repoDir, ".beads"), { recursive: true });
  writeFileSync(join(repoDir, ".beads", "metadata.json"), JSON.stringify({ project_id: "boundary-project" }));

  const scanner = new UnifiedScanner(db, { beadsSearchPath: root, observabilityRoots: [root], parityEnabled: false });
  await scanner.refresh();

  const row = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM sources WHERE source_key = 'beads:boundary-project'").get();
  assert.equal(row?.c, 1);

  const privateScanner = scanner as unknown as { logProbeFailure: (stage: string, path: string, error: unknown) => void };
  const secretPath = "/private/boundary-secret";
  const secretMessage = "token=boundary-secret";
  const before = getRing().length;
  privateScanner.logProbeFailure("boundary probe", secretPath, Object.assign(new Error(secretMessage), { code: "EACCES" }));
  const entries = getRing().slice(before);

  assert.deepEqual(entries.map((entry) => entry.data), [{ stage: "boundary probe", code: "EACCES" }]);
  assert.equal(JSON.stringify(entries).includes(secretPath), false);
  assert.equal(JSON.stringify(entries).includes(secretMessage), false);
  scanner.stop();
  console.log("unified scanner Bun/sqlite redaction smoke ok");
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
