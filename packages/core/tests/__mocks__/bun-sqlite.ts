// Shim: maps bun:sqlite -> node:sqlite for Vitest workers (Node runtime).
// Provides the Bun SQLite surface inside Vitest's Node workers.
// Uses createRequire to bypass Vite's static module analysis.
import { createRequire } from "module";

const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = _require("node:sqlite") as typeof import("node:sqlite");

type DbOpts = { create?: boolean; readonly?: boolean };

export class Database {
  private _db: InstanceType<typeof DatabaseSync>;

  constructor(path: string, _opts?: DbOpts) {
    this._db = new DatabaseSync(path);
  }

  exec(sql: string): void {
    this._db.exec(sql);
  }

  prepare(sql: string) {
    return this._db.prepare(sql);
  }

  query(sql: string) {
    return this._db.prepare(sql);
  }

  close(): void {
    this._db.close();
  }
}
