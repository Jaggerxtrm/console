import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Hono } from "hono";
import { createXtrmDatabase } from "../../../../packages/core/src/state/database.ts";
import { createBeadsWriteRouter } from "../../src/server/routes/beads-write.ts";
import { createFeedRouter } from "../../src/server/routes/feed.ts";
import { createGraphRouter, createXtrmGraphRoute } from "../../src/server/routes/graph.ts";
import { createInternalSubstrateRouter } from "../../src/server/routes/internal-substrate.ts";
import { createSourcesRouter } from "../../src/server/routes/sources.ts";
import { createSubstrateRouter } from "../../src/server/routes/substrate.ts";

const roots: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-23T01:00:00.000Z"));
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env.CONSOLE_WRITE_ADMIN_TOKEN;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Phase 2 Console API contract", () => {
  it("preserves read DTOs and persisted Beads mutations", async () => {
    process.env.CONSOLE_WRITE_ADMIN_TOKEN = "phase2-secret";
    const fixture = await createFixture("contract");
    const app = buildApp(fixture.db);

    for (const path of [
      "/api/substrate/projects",
      "/api/substrate/projects/repo-a/issues?status=open&limit=10",
      "/api/feed?limit=10",
      "/api/console/graph?project=repo-a",
      "/api/sources",
      "/api/internal/substrate/schema",
    ]) {
      const response = await app.request(`http://localhost${path}`, { headers: { host: "localhost" } });
      expect(response.status, path).toBe(200);
      const body = normalizeFixturePaths(await response.json(), fixture.root);
      expect(body, path).toEqual(expect.any(Object));
    }

    const request = () => new Request("http://localhost/api/substrate/projects/repo-a/issues", {
      method: "POST",
      headers: {
        host: "localhost",
        "content-type": "application/json",
        "x-console-write-token": "phase2-secret",
      },
      body: JSON.stringify({ title: "Persisted parity issue", priority: 1 }),
    });
    const write = await app.fetch(request());
    expect(write.status).toBe(200);
    expect(await write.json()).toMatchObject({
      issue: {
        id: "repo-a-new",
        title: "Persisted parity issue",
        status: "open",
        priority: 1,
        issue_type: "task",
        project_id: "repo-a",
      },
    });

    const row = fixture.db.query("SELECT title, priority FROM substrate_issues WHERE repo_slug = 'repo-a' AND issue_id = 'repo-a-new'").get();
    expect(row).toEqual({ title: "Persisted parity issue", priority: 1 });

    fixture.db.close();
  });

  it("keeps write authorization fail-closed for hostile and missing-origin requests", async () => {
    process.env.CONSOLE_WRITE_ADMIN_TOKEN = "phase2-secret";
    const fixture = await createFixture("auth");
    const app = buildApp(fixture.db);
    const body = JSON.stringify({ title: "Denied" });

    const hostile = await app.request("http://localhost/api/substrate/projects/repo-a/issues", {
      method: "POST",
      headers: { host: "localhost", origin: "https://attacker.example", "content-type": "application/json" },
      body,
    });
    const missingProof = await app.request("http://localhost/api/substrate/projects/repo-a/issues", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body,
    });

    expect(hostile.status).toBe(403);
    expect(missingProof.status).toBe(403);
    fixture.db.close();
  });
});

async function createFixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `console-phase2-${name}-`));
  roots.push(root);
  const db = createXtrmDatabase(join(root, "xtrm.sqlite"));
  const beadsPath = join(root, "repo-a", ".beads");
  db.query("INSERT INTO sources (source_key, kind, path, origin, status, discovered_at, last_seen_at) VALUES (?, 'beads', ?, 'manual', 'active', ?, ?)").run(
    "beads:repo-a",
    beadsPath,
    "2026-07-22T00:00:00.000Z",
    "2026-07-22T00:00:00.000Z",
  );
  db.query("INSERT INTO materialization_state (source_key, last_success_at, last_status) VALUES ('beads:repo-a', ?, 'success')").run("2026-07-22T00:00:00.000Z");
  db.query("INSERT INTO substrate_issues (repo_slug, issue_id, title, body, state, priority, issue_type, created_at, updated_at) VALUES ('repo-a', 'repo-a-1', 'Existing issue', 'Body', 'open', 2, 'task', ?, ?)").run(
    "2026-07-22T00:00:00.000Z",
    "2026-07-22T00:00:00.000Z",
  );
  return { db, root };
}

function normalizeFixturePaths(value: unknown, root: string): unknown {
  if (typeof value === "string") {
    return value.replaceAll(root, "<fixture-root>").replaceAll(basename(root), "<fixture-root>");
  }
  if (Array.isArray(value)) return value.map((item) => normalizeFixturePaths(item, root));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "generated_at" ? "<generated-at>" : normalizeFixturePaths(item, root),
    ]),
  );
}

function buildApp(db: ReturnType<typeof createXtrmDatabase>): Hono {
  const app = new Hono();
  app.route("/api/substrate", createSubstrateRouter(db));
  app.route("/api/substrate", createBeadsWriteRouter(db, writeOptions(db)));
  app.route("/api/feed", createFeedRouter(db));
  app.route("/api/console/graph", createGraphRouter(createXtrmGraphRoute(db)));
  app.route("/api/sources", createSourcesRouter(db));
  app.route("/api/internal", createInternalSubstrateRouter(db));
  return app;
}

function writeOptions(db: ReturnType<typeof createXtrmDatabase>) {
  return {
    runBdCommand: async (_repoPath: string, _command: string[], _op: string) => {
      db.query("INSERT INTO substrate_issues (repo_slug, issue_id, title, state, priority, issue_type, created_at, updated_at) VALUES ('repo-a', 'repo-a-new', 'Persisted parity issue', 'open', 1, 'task', ?, ?)").run(
        "2026-07-22T00:01:00.000Z",
        "2026-07-22T00:01:00.000Z",
      );
      return {
        stdout: JSON.stringify({ id: "repo-a-new", title: "Persisted parity issue", priority: 1, status: "open", issue_type: "task" }),
        stderr: "",
        exitCode: 0,
      };
    },
  };
}
