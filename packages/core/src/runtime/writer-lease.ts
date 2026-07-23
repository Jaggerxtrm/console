import { Database } from "bun:sqlite";

export interface RuntimeWriterLease {
  readonly owner: string;
  readonly pid: number;
  readonly lockPath: string;
  release(): void;
}

/**
 * Holds an OS-backed SQLite EXCLUSIVE transaction in a sidecar database.
 * SQLite releases its file lock when the process or connection exits, so
 * crashes cannot leave stale PID records and concurrent recovery cannot unlink
 * another process's live lease.
 */
export function acquireRuntimeWriterLease(databasePath: string, options: { owner: string; pid?: number }): RuntimeWriterLease {
  const lockPath = `${databasePath}.runtime-writer.sqlite`;
  const pid = options.pid ?? process.pid;
  const leaseDb = new Database(lockPath, { create: true });
  leaseDb.exec("PRAGMA busy_timeout = 0");
  try {
    leaseDb.exec("CREATE TABLE IF NOT EXISTS runtime_writer_lease (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, pid INTEGER NOT NULL, acquired_at TEXT NOT NULL)");
    leaseDb.exec("BEGIN EXCLUSIVE");
    leaseDb.query("INSERT INTO runtime_writer_lease (id, owner, pid, acquired_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, pid=excluded.pid, acquired_at=excluded.acquired_at")
      .run(options.owner, pid, new Date().toISOString());
  } catch (error) {
    leaseDb.close();
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "SQLITE_BUSY" || (error instanceof Error && /database is locked/i.test(error.message))) {
      throw new Error("active runtime writer");
    }
    throw error;
  }

  let released = false;
  return {
    owner: options.owner,
    pid,
    lockPath,
    release: () => {
      if (released) return;
      released = true;
      try {
        leaseDb.exec("ROLLBACK");
      } finally {
        leaseDb.close();
      }
    },
  };
}
