import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createSourcesRouter } from "../../../src/api/routes/sources.ts";
import { createXtrmDatabase } from "../../../src/core/xtrm-store.ts";
import { listSources } from "../../../../../packages/core/src/state/index.ts";

describe("sources routes", () => {
  let tmpDir: string;
  let dbPath: string;
  let originalAdminToken: string | undefined;

  beforeEach(async () => {
    originalAdminToken = process.env.GITBOARD_SOURCES_ADMIN_TOKEN;
    process.env.GITBOARD_SOURCES_ADMIN_TOKEN = "secret";
    tmpDir = await mkdtemp(join(tmpdir(), "gitboard-sources-"));
    dbPath = join(tmpDir, "xtrm.sqlite");
  });

  afterEach(async () => {
    if (originalAdminToken === undefined) delete process.env.GITBOARD_SOURCES_ADMIN_TOKEN;
    else process.env.GITBOARD_SOURCES_ADMIN_TOKEN = originalAdminToken;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns list DTO matching core source read-model output", async () => {
    const db = createXtrmDatabase(dbPath);
    const app = createSourcesRouter(db);
    db.exec(`
      INSERT INTO sources (source_key, kind, path, origin, status, discovered_at, last_seen_at)
      VALUES
        ('beads:/repo-a', 'beads', '/repo-a', 'manual', 'active', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'),
        ('observability:repo-a', 'observability', 'repo-a', 'discovered', 'active', NULL, '2026-01-03T00:00:00Z');
    `);

    const response = await app.fetch(new Request("http://localhost", { headers: { host: "localhost" } }));
    expect(response.status).toBe(200);
    const body = await response.json() as { sources: unknown[] };

    expect(body.sources).toEqual(listSources(db).map(({ path, ...source }) => ({
      ...source,
      display_path: path,
    })));

    db.close();
  });

  it("pins a source and upserts on repeat pin", async () => {
    const db = createXtrmDatabase(dbPath);
    const app = createSourcesRouter(db);

    const first = await app.fetch(new Request("http://localhost/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost", "x-gitboard-sources-admin-token": "secret" },
      body: JSON.stringify({ path: "/repo", kind: "beads" }),
    }));
    expect(first.status).toBe(200);
    expect((await first.json()).display_path).toBe("/repo");

    const second = await app.fetch(new Request("http://localhost/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost", "x-gitboard-sources-admin-token": "secret" },
      body: JSON.stringify({ path: "/repo", kind: "beads" }),
    }));
    expect(second.status).toBe(200);

    const row = db.query<{ origin: string; status: string }, []>("SELECT origin, status FROM sources WHERE source_key = 'beads:/repo'").get();
    expect(row?.origin).toBe("manual");
    expect(row?.status).toBe("active");

    db.close();
  });

  it("rejects unknown origin and spoofed requests", async () => {
    const db = createXtrmDatabase(dbPath);
    const app = createSourcesRouter(db);

    const badKind = await app.fetch(new Request("http://localhost/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost", "x-gitboard-sources-admin-token": "secret" },
      body: JSON.stringify({ path: "/repo", kind: "unknown" }),
    }));
    expect(badKind.status).toBe(400);

    const missingToken = await app.fetch(new Request("http://localhost/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost" },
      body: JSON.stringify({ path: "/repo", kind: "beads" }),
    }));
    expect(missingToken.status).toBe(403);

    const wrongToken = await app.fetch(new Request("http://localhost/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost", "x-gitboard-sources-admin-token": "wrong" },
      body: JSON.stringify({ path: "/repo", kind: "beads" }),
    }));
    expect(wrongToken.status).toBe(403);

    const spoofed = await app.fetch(new Request("http://example.com/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost", "x-gitboard-sources-admin-token": "secret" },
      body: JSON.stringify({ path: "/repo", kind: "beads" }),
    }));
    expect(spoofed.status).toBe(403);

    const crossOrigin = await app.fetch(new Request("http://localhost/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost", origin: "https://example.com", "x-gitboard-sources-admin-token": "secret" },
      body: JSON.stringify({ path: "/repo", kind: "beads" }),
    }));
    expect(crossOrigin.status).toBe(403);

    db.close();
  });

  it("unpinns or tombstones historical sources", async () => {
    const db = createXtrmDatabase(dbPath);
    const app = createSourcesRouter(db);
    db.query("INSERT INTO sources (source_key, kind, path, origin, status) VALUES ('beads:/repo', 'beads', '/repo', 'manual', 'active')").run();
    db.query("INSERT INTO materialization_state (source_key) VALUES ('beads:/repo')").run();

    const response = await app.fetch(new Request("http://localhost/pin/beads%3A%2Frepo", { method: "DELETE", headers: { host: "localhost", "x-gitboard-sources-admin-token": "secret" } }));
    expect(response.status).toBe(200);

    const row = db.query<{ status: string; origin: string }, []>("SELECT status, origin FROM sources WHERE source_key = 'beads:/repo'").get();
    expect(row?.origin).toBe("manual");
    expect(row?.status).toBe("unpinned");

    db.close();
  });

  it("rejects unpinning discovered sources", async () => {
    const db = createXtrmDatabase(dbPath);
    const app = createSourcesRouter(db);
    db.query("INSERT INTO sources (source_key, kind, path, origin, status) VALUES ('beads:/repo', 'beads', '/repo', 'discovered', 'active')").run();

    const response = await app.fetch(new Request("http://localhost/pin/beads%3A%2Frepo", { method: "DELETE", headers: { host: "localhost", "x-gitboard-sources-admin-token": "secret" } }));
    expect(response.status).toBe(409);

    const row = db.query<{ origin: string; status: string }, []>("SELECT origin, status FROM sources WHERE source_key = 'beads:/repo'").get();
    expect(row?.origin).toBe("discovered");
    expect(row?.status).toBe("active");

    db.close();
  });
});
