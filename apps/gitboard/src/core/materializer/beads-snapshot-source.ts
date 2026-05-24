import type { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import type { BeadIssue } from "../../types/beads.ts";
import { readIssuesFromJsonl } from "../jsonl-reader.ts";
import type { DoltClient } from "../dolt-client.ts";
import { snapshotHash } from "./snapshot-diff.ts";

export interface BeadsSnapshotSourceOptions {
  sourceKey: string;
  beadsPath: string;
  doltClient?: Pick<DoltClient, "getIssues">;
  doltCommitHash?: string | null;
  xtrmDb?: Database;
}

export interface BeadsSnapshotMeta {
  dolt_commit_hash: string | null;
  jsonl_mtime_ms: number | null;
}

export class BeadsSnapshotSource {
  constructor(private readonly options: BeadsSnapshotSourceOptions) {}

  async readSnapshot(): Promise<BeadIssue[]> {
    const doltIssues = await this.readFromDolt();
    if (doltIssues) return doltIssues;
    return readIssuesFromJsonl(this.options.beadsPath);
  }

  async snapshotHash(): Promise<string> {
    const rows = await this.readSnapshot();
    return snapshotHash(rows, (row) => row.id);
  }

  async shouldSkipRead(sourceKey = this.options.sourceKey): Promise<boolean> {
    const current = await this.getCurrentMeta();
    const previous = await this.getLastSuccessfulMeta(sourceKey);
    if (!current || !previous) return false;
    if (!isDefined(current.dolt_commit_hash) || !isDefined(previous.dolt_commit_hash)) return false;
    if (!isDefined(current.jsonl_mtime_ms) || !isDefined(previous.jsonl_mtime_ms)) return false;
    return current.dolt_commit_hash === previous.dolt_commit_hash && current.jsonl_mtime_ms === previous.jsonl_mtime_ms;
  }

  private async readFromDolt(): Promise<BeadIssue[] | null> {
    if (!this.options.doltClient) return null;
    try {
      return await this.options.doltClient.getIssues({ limit: 1000 });
    } catch {
      return null;
    }
  }

  private async getCurrentMeta(): Promise<BeadsSnapshotMeta | null> {
    const [jsonlMtimeMs, commitHash] = await Promise.all([this.readJsonlMtimeMs(), this.readDoltCommitHash()]);
    if (!commitHash && jsonlMtimeMs === null) return null;
    return { dolt_commit_hash: commitHash, jsonl_mtime_ms: jsonlMtimeMs };
  }

  private async getLastSuccessfulMeta(sourceKey: string): Promise<BeadsSnapshotMeta | null> {
    if (!this.options.xtrmDb) return null;
    const row = this.options.xtrmDb.query("SELECT cursor FROM materialization_state WHERE source_key = ? AND last_status = 'success'").get(sourceKey) as { cursor: string | null } | undefined;
    if (!row?.cursor) return null;
    try {
      const cursor = JSON.parse(row.cursor) as Partial<BeadsSnapshotMeta>;
      return {
        dolt_commit_hash: typeof cursor.dolt_commit_hash === "string" ? cursor.dolt_commit_hash : null,
        jsonl_mtime_ms: typeof cursor.jsonl_mtime_ms === "number" ? cursor.jsonl_mtime_ms : null,
      };
    } catch {
      return null;
    }
  }

  private async readDoltCommitHash(): Promise<string | null> {
    return this.options.doltCommitHash ?? null;
  }

  private async readJsonlMtimeMs(): Promise<number | null> {
    try {
      const live = await stat(`${this.options.beadsPath}/issues.jsonl`);
      return live.mtimeMs;
    } catch {
      try {
        const backup = await stat(`${this.options.beadsPath}/backup/issues.jsonl`);
        return backup.mtimeMs;
      } catch {
        return null;
      }
    }
  }
}

function isDefined(value: string | number | null): value is string | number {
  return value !== null;
}
