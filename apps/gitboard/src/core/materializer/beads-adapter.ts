import type { Database } from "bun:sqlite";
import { BeadsAdapter as CoreBeadsAdapter } from "../../../../../packages/core/src/materializer/beads-adapter.ts";
import type { BeadIssue } from "../../types/beads.ts";
import { emit, makeLogEntry } from "../logger.ts";
import { BeadsSnapshotSource } from "./beads-snapshot-source.ts";

export type { BeadsAdapterPorts, MaterializerBeadDependency, MaterializerBeadIssue } from "../../../../../packages/core/src/materializer/beads-adapter.ts";

export interface BeadsAdapterOptions {
  sourceKey: string;
  projectId: string;
  beadsPath: string;
  xtrmDb: Database;
  doltPort?: number;
  doltDatabase?: string;
}

/**
 * Host adapter: wires core BeadsAdapter runtime ports to app-owned snapshot
 * reads (Dolt/jsonl via BeadsSnapshotSource) and the app logger. Core owns the
 * write/normalize/diff logic.
 */
export class BeadsAdapter extends CoreBeadsAdapter {
  constructor(options: BeadsAdapterOptions) {
    const source = new BeadsSnapshotSource({
      sourceKey: options.sourceKey,
      beadsPath: options.beadsPath,
      doltCommitHash: null,
      xtrmDb: options.xtrmDb,
      doltPort: options.doltPort,
      doltClient: options.doltPort && options.doltDatabase ? createLazyDoltClient(options.doltPort, options.doltDatabase) : undefined,
    });
    super({
      sourceKey: options.sourceKey,
      projectId: options.projectId,
      xtrmDb: options.xtrmDb,
      readSnapshot: () => source.readSnapshot(),
      emitLog: (entry) => {
        emit(makeLogEntry(entry.component, entry.event, entry.level, entry.message, entry.data));
      },
    });
  }
}

function createLazyDoltClient(port: number, database: string): { getIssues(options: { limit: number }): Promise<BeadIssue[]> } {
  return {
    async getIssues(options: { limit: number }): Promise<BeadIssue[]> {
      const { DoltClient } = await import("../dolt-client.ts");
      const client = new DoltClient({ host: "127.0.0.1", port, database });
      try {
        return await client.getIssues(options);
      } finally {
        // Each call leaks a mysql2 pool otherwise — 15 projects × ~30s materializer cycle
        // accumulated 1000+ connections in 53 min, exhausting dolt's max_connections.
        await client.disconnect().catch(() => { /* swallow on shutdown race */ });
      }
    },
  };
}
