const REQUIRED_TABLES = {
  specialist_jobs: [
    "job_id",
    "bead_id",
    "chain_id",
    "epic_id",
    "chain_kind",
    "status",
    "updated_at_ms",
    "specialist",
  ],
} as const;

export function isCompatible(db: import("bun:sqlite").Database): boolean {
  return hasRequiredTable(db, "specialist_jobs", REQUIRED_TABLES.specialist_jobs);
}

function hasRequiredTable(db: import("bun:sqlite").Database, tableName: string, requiredColumns: readonly string[]): boolean {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(tableName) as { name: string } | undefined;
  if (!table) return false;

  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  const existingColumns = new Set(columns.map((column) => column.name));
  return requiredColumns.every((column) => existingColumns.has(column));
}
