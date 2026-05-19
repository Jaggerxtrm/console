import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "observability");
mkdirSync(dir, { recursive: true });

seedCompat(join(dir, "repo-a.db"));
seedCompat(join(dir, "repo-b.db"));
seedMismatch(join(dir, "repo-c.db"));

function seedCompat(path) {
  const db = new Database(path, { create: true });
  try {
    db.exec("CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL);");
    db.exec("INSERT OR IGNORE INTO schema_version(version, applied_at_ms) VALUES (1, 0);");
    db.exec(`CREATE TABLE IF NOT EXISTS specialist_jobs(
      job_id TEXT PRIMARY KEY,
      specialist TEXT NOT NULL,
      bead_id TEXT,
      chain_id TEXT,
      epic_id TEXT,
      chain_kind TEXT,
      status TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );`);
    db.exec("INSERT OR IGNORE INTO specialist_jobs(job_id, specialist, bead_id, status, updated_at_ms) VALUES ('seed-job', 'explorer', 'seed-bead', 'closed', 0);");
  } finally {
    db.close();
  }
}

function seedMismatch(path) {
  writeFileSync(path, "not-sqlite");
}
