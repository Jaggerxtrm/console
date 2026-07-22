import { describe, expect, it } from "vitest";
import type { Database } from "bun:sqlite";
import { readSpecialistRecentJobs } from "../src/state/read-models/specialists.ts";

describe("specialists recent read bound", () => {
  it("returns empty SQL result and binds zero limit", () => {
    const queries: string[] = [];
    let queryParams: unknown[] = [];
    const db = {
      query(sql: string) {
        queries.push(sql);
        if (sql.includes("FROM specialist_jobs AS j")) {
          return {
            all(...params: unknown[]) {
              queryParams = params;
              return [];
            },
          };
        }
        if (sql.includes("sqlite_master")) return { get: () => ({}) };
        if (sql.includes("PRAGMA table_info")) return { all: () => [{ name: "bead_id" }] };
        throw new Error(`unexpected query: ${sql}`);
      },
    } as unknown as Database;

    expect(readSpecialistRecentJobs(db, 0)).toEqual([]);
    expect(queries.find((query) => query.includes("FROM specialist_jobs AS j"))).toMatch(/LIMIT \?/);
    expect(queryParams).toEqual([0]);
  });

  it("pushes requested history limit into SQL", () => {
    const queries: string[] = [];
    let queryParams: unknown[] = [];
    const db = {
      query(sql: string) {
        queries.push(sql);
        if (sql.includes("FROM specialist_jobs AS j")) {
          return {
            all(...params: unknown[]) {
              queryParams = params;
              return [];
            },
          };
        }
        if (sql.includes("sqlite_master")) return { get: () => ({}) };
        if (sql.includes("PRAGMA table_info")) return { all: () => [{ name: "bead_id" }] };
        throw new Error(`unexpected query: ${sql}`);
      },
    } as unknown as Database;

    expect(readSpecialistRecentJobs(db, 2)).toEqual([]);
    expect(queries.find((query) => query.includes("FROM specialist_jobs AS j"))).toMatch(/LIMIT \?/);
    expect(queryParams).toEqual([2]);
  });
});
