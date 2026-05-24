import type { MaterializedIssue, MaterializerAdapter, MaterializerCursor } from "../../../../src/core/materializer/types.ts";

type EchoRow = MaterializedIssue & { key: string };

export class EchoAdapter implements MaterializerAdapter {
  private readonly rows = new Map<string, EchoRow>();
  private cursorVersion = 0;

  seed(rows: readonly EchoRow[]): void {
    for (const row of rows) this.rows.set(row.key, row);
  }

  upsert(row: EchoRow): void {
    this.rows.set(row.key, row);
  }

  delete(key: string): void {
    const row = this.rows.get(key);
    if (!row) return;
    this.rows.set(key, { ...row, deleted_at: new Date().toISOString(), state: "deleted" });
  }

  cursor(): Promise<MaterializerCursor> {
    return Promise.resolve({ version: this.cursorVersion });
  }

  async changesSince(cursor: MaterializerCursor): Promise<{ cursor: MaterializerCursor; rows: readonly MaterializedIssue[] }> {
    void cursor;
    this.cursorVersion += 1;
    return { cursor: { version: this.cursorVersion }, rows: [...this.rows.values()].map(({ key, ...row }) => row) };
  }

  snapshot(): Promise<{ rows: readonly MaterializedIssue[] }> {
    return Promise.resolve({ rows: [...this.rows.values()].map(({ key, ...row }) => row) });
  }
}
