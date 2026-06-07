// Lightweight in-memory SQL engine for vitest that mirrors the slice of the
// bun:sqlite Database surface used by the read-model services. Uses
// better-sqlite3 when available so we can exercise the actual SQL without
// requiring a Bun runtime.

import DatabaseCtor from "better-sqlite3";

type SqlValue = string | number | null | bigint | Buffer | Uint8Array;

interface QueryBindParams {
  [key: string]: SqlValue;
}

interface BunQuery {
  get<T = unknown>(...params: SqlValue[]): T | undefined;
  get<T = unknown>(params: QueryBindParams): T | undefined;
  all<T = unknown>(...params: SqlValue[]): T[];
  all<T = unknown>(params: QueryBindParams): T[];
  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
  run(params: QueryBindParams): { changes: number; lastInsertRowid: number | bigint };
}

export type FakeDatabase = {
  query<T = unknown, P extends unknown[] = []>(sql: string): BunQuery & { get: (...args: P) => T | undefined; all: (...args: P) => T[] };
  exec(sql: string): void;
  close(): void;
};

export function createFakeDatabase(): FakeDatabase {
  const inner = new DatabaseCtor(":memory:");
  return {
    query: (sql: string) => makeQuery(inner, sql),
    exec: (sql: string) => {
      inner.exec(sql);
    },
    close: () => inner.close(),
  };
}

function makeQuery(inner: DatabaseCtor.Database, sql: string): BunQuery {
  const normalizeParams = (args: unknown[]): unknown[] => {
    if (args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) {
      const named = args[0] as Record<string, unknown>;
      return Object.values(named);
    }
    return args;
  };
  return {
    get<T = unknown>(...args: unknown[]): T | undefined {
      try {
        return inner.prepare(sql).get(...normalizeParams(args)) as T | undefined;
      } catch (error) {
        throw new SqlRewriteError(sql, error);
      }
    },
    all<T = unknown>(...args: unknown[]): T[] {
      try {
        return inner.prepare(sql).all(...normalizeParams(args)) as T[];
      } catch (error) {
        throw new SqlRewriteError(sql, error);
      }
    },
    run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
      const info = inner.prepare(sql).run(...normalizeParams(args));
      return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
    },
  };
}

class SqlRewriteError extends Error {
  constructor(sql: string, cause: unknown) {
    super(`SQL failed: ${sql} (${cause instanceof Error ? cause.message : String(cause)})`);
  }
}
