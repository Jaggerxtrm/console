import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { getRing, setDiskEnabled } from "../../src/core/logger.ts";
import { createObservabilityParityHarness } from "../../src/server/observability/parity.ts";

const tmpDir = join(process.cwd(), ".tmp-parity-cycle");
const logPath = join(process.cwd(), "tests/smoke/p1-parity-cycle.log");

function rows(count: number): Array<{ repo_slug: string; job_id: string; bead_id: string; status: string; updated_at: number; specialist: string; last_output: string }> {
  return Array.from({ length: count }, (_, index) => ({
    repo_slug: "repo-alpha",
    job_id: `job-${index}`,
    bead_id: `bead-${index % 4}`,
    status: index % 3 === 0 ? "running" : "done",
    updated_at: 1_000_000 + index,
    specialist: "explorer",
    last_output: `out-${index}`,
  }));
}

function initDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec(`CREATE TABLE specialist_jobs (
    repo_slug TEXT NOT NULL,
    job_id TEXT NOT NULL,
    bead_id TEXT NOT NULL,
    chain_id TEXT,
    epic_id TEXT,
    chain_kind TEXT,
    status TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    specialist TEXT,
    last_output TEXT,
    PRIMARY KEY (repo_slug, job_id)
  );`);
  return db;
}

function seed(db: Database, seedRows: ReturnType<typeof rows>): void {
  const stmt = db.prepare("INSERT OR REPLACE INTO specialist_jobs (repo_slug, job_id, bead_id, chain_id, epic_id, chain_kind, status, updated_at, specialist, last_output) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)");
  for (const row of seedRows) stmt.run(row.repo_slug, row.job_id, row.bead_id, row.status, row.updated_at, row.specialist, row.last_output);
}

async function main(): Promise<void> {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(join(process.cwd(), "tests/smoke"), { recursive: true });

  setDiskEnabled(false);
  const sourceDb = initDb(join(tmpDir, "source.sqlite"));
  const shadowDb = initDb(join(tmpDir, "xtrm.sqlite"));
  const seedRows = rows(24);
  seed(sourceDb, seedRows);
  seed(shadowDb, seedRows);

  const harness = createObservabilityParityHarness(shadowDb, {
    enabled: false,
    liveDao: {
      inFlightJobs: () => readJobs(sourceDb, "WHERE status IN ('starting','running','waiting')"),
      jobsByBead: (beadId) => readJobs(sourceDb, "WHERE bead_id = ?", [beadId]),
      recentJobs: (limit) => readJobs(sourceDb, "WHERE status IN ('done','error','cancelled') ORDER BY updated_at DESC LIMIT ?", [limit]),
    },
    shadowDao: {
      inFlightJobs: () => readJobs(shadowDb, "WHERE status IN ('starting','running','waiting')"),
      jobsByBead: (beadId) => readJobs(shadowDb, "WHERE bead_id = ?", [beadId]),
      recentJobs: (limit) => readJobs(shadowDb, "WHERE status IN ('done','error','cancelled') ORDER BY updated_at DESC LIMIT ?", [limit]),
    },
  });

  for (let cycle = 1; cycle <= 5; cycle += 1) {
    const summary = await harness.tick();
    if (summary.diff_count !== 0) throw new Error(`expected zero diffs in cycle ${cycle}`);
    if (summary.parity_ok_count !== cycle) throw new Error(`expected parity_ok_count ${cycle}`);
  }

  shadowDb.prepare("UPDATE specialist_jobs SET last_output = ? WHERE job_id = ?").run("diverged", "job-0");
  const before = getRing().length;
  const summary = await harness.tick();
  if (summary.diff_count === 0) throw new Error("expected diff after divergence");
  if (getRing().length <= before) throw new Error("expected parity log emission");

  const log = `${new Date().toISOString()} cycles=5 parity_ok_count=${harness.getParityOkCount()} diff_count=${summary.diff_count} log_events=${getRing().filter((entry) => entry.event === "parity.observability").length}`;
  writeFileSync(logPath, `${log}\n`);
  sourceDb.close();
  shadowDb.close();
  console.log(log);
}

function readJobs(db: Database, whereSql: string, params: readonly unknown[] = []): Array<{ jobId: string | null; repoSlug: string; beadId: string; chainId: string | null; epicId: string | null; chainKind: string | null; status: string; updatedAt: string; specialist: string | null; lastOutput: string | null; turns: null; tools: null; model: null }> {
  const rows = db.prepare(`SELECT repo_slug, job_id, bead_id, chain_id, epic_id, chain_kind, status, updated_at, specialist, last_output FROM specialist_jobs ${whereSql}`).all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    jobId: row.job_id == null ? null : String(row.job_id),
    repoSlug: String(row.repo_slug),
    beadId: String(row.bead_id),
    chainId: row.chain_id == null ? null : String(row.chain_id),
    epicId: row.epic_id == null ? null : String(row.epic_id),
    chainKind: row.chain_kind == null ? null : String(row.chain_kind),
    status: String(row.status),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
    specialist: row.specialist == null ? null : String(row.specialist),
    lastOutput: row.last_output == null ? null : String(row.last_output),
    turns: null,
    tools: null,
    model: null,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
