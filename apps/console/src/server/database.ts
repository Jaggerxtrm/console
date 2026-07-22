import { mkdirSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type { DataDirResolution } from "./data-dir.ts";

export interface ConsoleDatabaseHandle {
  readonly path: string;
  readonly db: Database;
  close(): void;
}

/** Opens (and initializes) a SQLite database at `path`. */
export type ConsoleDatabaseFactory = (path: string) => Database;

/**
 * Console-owned database bootstrap seam. `ensureDataDir` is the Phase 1 side
 * effect (the host guarantees the data directory exists before serving).
 * `open`/`close` are deferred: Phase 1 opens no production state because no API
 * or materializer consumes the database yet; Phase 2+ calls `open()` when the
 * read-model routes move, using the injected core factory.
 */
export interface ConsoleDatabaseBootstrap {
  readonly storeDbPath: string;
  readonly legacyFoldDbPath: string;
  ensureDataDir(): string;
  open(): ConsoleDatabaseHandle;
}

export function createDatabaseBootstrap(
  dataDir: DataDirResolution,
  factory: ConsoleDatabaseFactory,
): ConsoleDatabaseBootstrap {
  return {
    storeDbPath: dataDir.storeDbPath,
    legacyFoldDbPath: dataDir.legacyFoldDbPath,
    ensureDataDir: () => {
      mkdirSync(dataDir.dataDir, { recursive: true });
      return dataDir.dataDir;
    },
    open: () => {
      mkdirSync(dataDir.dataDir, { recursive: true });
      const db = factory(dataDir.storeDbPath);
      return { path: dataDir.storeDbPath, db, close: () => db.close() };
    },
  };
}
