import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Hono } from "hono";
import { createXtrmDatabase } from "../../../../packages/core/src/state/database.ts";
import { createBeadsWriteRouter as createConsoleBeadsWriteRouter } from "../../src/server/routes/beads-write.ts";
import { createFeedRouter as createConsoleFeedRouter } from "../../src/server/routes/feed.ts";
import { createGraphRouter as createConsoleGraphRouter, createXtrmGraphRoute } from "../../src/server/routes/graph.ts";
import { createInternalSubstrateRouter as createConsoleInternalSubstrateRouter } from "../../src/server/routes/internal-substrate.ts";
import { createSourcesRouter as createConsoleSourcesRouter } from "../../src/server/routes/sources.ts";
import { createSubstrateRouter as createConsoleSubstrateRouter } from "../../src/server/routes/substrate.ts";
import { createBeadsWriteRouter as createGitboardBeadsWriteRouter } from "../../../gitboard/src/api/routes/beads-write.ts";
import { createFeedRouter as createGitboardFeedRouter } from "../../../gitboard/src/api/routes/feed.ts";
import { createGraphRouter as createGitboardGraphRouter } from "../../../gitboard/src/api/routes/graph.ts";
import { createInternalSubstrateRouter as createGitboardInternalSubstrateRouter } from "../../../gitboard/src/api/routes/internal-substrate.ts";
import { createSourcesRouter as createGitboardSourcesRouter } from "../../../gitboard/src/api/routes/sources.ts";
import { createSubstrateRouter as createGitboardSubstrateRouter } from "../../../gitboard/src/api/routes/substrate.ts";

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

describe("Phase 2 old/new host parity", () => {
  it("keeps read DTOs and persisted Beads mutations identical", async () => {
    process.env.CONSOLE_WRITE_ADMIN_TOKEN = "phase2-secret";
    const oldFixture = await createFixture("old");
    const newFixture = await createFixture("new");
    const oldApp = buildOldApp(oldFixture.db);
    const newApp = buildNewApp(newFixture.db);

    for (const path of [
      "/api/substrate/projects",
      "/api/substrate/projects/repo-a/issues?status=open&limit=10",
      "/api/feed?limit=10",
      "/api/console/graph?project=repo-a",
      "/api/sources",
      "/api/internal/substrate/schema",
    ]) {
      const [oldResponse, newResponse] = await Promise.all([
        oldApp.request(`http://localhost${path}`, { headers: { host: "localhost" } }),
        newApp.request(`http://localhost${path}`, { headers: { host: "localhost" } }),
      ]);
      expect(oldResponse.status, path).toBe(200);
      expect(newResponse.status, path).toBe(oldResponse.status);
      expect(normalizeFixturePaths(await newResponse.json(), newFixture.root), path)
        .toEqual(normalizeFixturePaths(await oldResponse.json(), oldFixture.root));
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
    const [oldWrite, newWrite] = await Promise.all([oldApp.fetch(request()), newApp.fetch(request())]);
    expect(oldWrite.status).toBe(200);
    expect(newWrite.status).toBe(oldWrite.status);
    const oldWriteBody = await oldWrite.json();
    const newWriteBody = await newWrite.json();
    expect(newWriteBody).toEqual(oldWriteBody);
    expect(newWriteBody).toMatchObject({
      issue: {
        id: "repo-a-new",
        title: "Persisted parity issue",
        status: "open",
        priority: 1,
        issue_type: "task",
        project_id: "repo-a",
      },
    });

    const oldRow = oldFixture.db.query("SELECT title, priority FROM substrate_issues WHERE repo_slug = 'repo-a' AND issue_id = 'repo-a-new'").get();
    const newRow = newFixture.db.query("SELECT title, priority FROM substrate_issues WHERE repo_slug = 'repo-a' AND issue_id = 'repo-a-new'").get();
    expect(newRow).toEqual(oldRow);
    expect(newRow).toEqual({ title: "Persisted parity issue", priority: 1 });

    oldFixture.db.close();
    newFixture.db.close();
  });

  it("keeps write authorization fail-closed for hostile and missing-origin requests", async () => {
    process.env.CONSOLE_WRITE_ADMIN_TOKEN = "phase2-secret";
    const fixture = await createFixture("auth");
    const app = buildNewApp(fixture.db);
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

function buildOldApp(db: ReturnType<typeof createXtrmDatabase>): Hono {
  const app = new Hono();
  app.route("/api/substrate", createGitboardSubstrateRouter(db));
  app.route("/api/substrate", createGitboardBeadsWriteRouter(db, writeOptions(db)));
  app.route("/api/feed", createGitboardFeedRouter(db));
  app.route("/api/console/graph", createGitboardGraphRouter(createXtrmGraphRoute(db)));
  app.route("/api/sources", createGitboardSourcesRouter(db));
  app.route("/api/internal", createGitboardInternalSubstrateRouter(db));
  return app;
}

function buildNewApp(db: ReturnType<typeof createXtrmDatabase>): Hono {
  const app = new Hono();
  app.route("/api/substrate", createConsoleSubstrateRouter(db));
  app.route("/api/substrate", createConsoleBeadsWriteRouter(db, writeOptions(db)));
  app.route("/api/feed", createConsoleFeedRouter(db));
  app.route("/api/console/graph", createConsoleGraphRouter(createXtrmGraphRoute(db)));
  app.route("/api/sources", createConsoleSourcesRouter(db));
  app.route("/api/internal", createConsoleInternalSubstrateRouter(db));
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
