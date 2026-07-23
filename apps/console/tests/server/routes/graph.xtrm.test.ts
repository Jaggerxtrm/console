import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createGraphRouter, createXtrmGraphRoute } from "../../../src/server/routes/graph.ts";
import { createXtrmDatabase } from "../../../../../packages/core/src/state/database.ts";
import { readXtrmGraphSnapshot } from "../../../../../packages/core/src/state/index.ts";

describe("graph route xtrm source", () => {
  it("surfaces xtrm graph health without letting GET refresh trigger materializer", async () => {
    const db = createXtrmDatabase(":memory:");
    const triggered: Array<string | null | undefined> = [];
    db.query("INSERT INTO sources (source_key, kind, path, origin, status) VALUES ('beads:repo-a', 'beads', '/tmp/repo-a/.beads', 'discovered', 'active')").run();
    db.query("INSERT INTO substrate_issues (repo_slug, issue_id, title, state, priority, issue_type) VALUES ('repo-a', 'A', 'Alpha', 'open', 1, 'task')").run();
    db.query("INSERT INTO materialization_state (source_key, last_success_at, last_status, last_error) VALUES ('beads:repo-a', CURRENT_TIMESTAMP, 'error', 'source offline')").run();

    const app = new Hono();
    app.route("/api/console/graph", createGraphRouter(createXtrmGraphRoute(db, (projectId) => triggered.push(projectId))));

    const response = await app.fetch(new Request("http://localhost/api/console/graph?project=repo-a&refresh=true"));
    const json = await response.json() as {
      freshness: string;
      project_id: string;
      repo_slug: string;
      source_health: { status: string; message?: string; metadata?: Record<string, unknown> };
      nodes: Array<{ id: string }>;
      edges: unknown[];
      specialists: unknown[];
    };

    expect(response.status).toBe(200);
    expect(triggered).toEqual([]);
    expect(json.freshness).toBe("fresh");
    expect(json.source_health.status).toBe("degraded");
    expect(json.source_health.metadata).toEqual(expect.objectContaining({ last_status: "error" }));
    expect(json.source_health.metadata).not.toHaveProperty("source_key");
    const coreSnapshot = readXtrmGraphSnapshot(db, "repo-a", false);
    expect(json.nodes).toEqual(coreSnapshot.graph.nodes);
    expect(json.edges).toEqual(coreSnapshot.graph.edges);
    expect(json.specialists).toEqual(coreSnapshot.graph.specialists);
    expect(json.freshness).toEqual(coreSnapshot.freshness);
    expect(json.project_id).toEqual(coreSnapshot.graph.project_id);
    expect(json.repo_slug).toEqual(coreSnapshot.graph.repo_slug);
    expect(coreSnapshot.sourceHealth).toBeDefined();
    expect(json.source_health.status).toEqual(coreSnapshot.sourceHealth?.status);
    expect(json.source_health.message).toEqual(coreSnapshot.sourceHealth?.message);
    const { age_seconds: jsonAgeSeconds, ...jsonMetadata } = json.source_health.metadata ?? {};
    const { age_seconds: coreAgeSeconds, ...coreMetadata } = coreSnapshot.sourceHealth?.metadata ?? {};
    expect(jsonMetadata).toEqual(coreMetadata);
    expect(typeof jsonAgeSeconds).toBe("number");
    expect(typeof coreAgeSeconds).toBe("number");
    if (typeof jsonAgeSeconds === "number" && typeof coreAgeSeconds === "number") {
      expect(Math.abs(jsonAgeSeconds - coreAgeSeconds)).toBeLessThanOrEqual(1);
    }
    expect(json.nodes.map((node) => node.id)).toEqual(["A"]);

    db.close();
  });

  it("protects POST invalidate and accepts primary token with legacy fallback", async () => {
    const originalPrimaryToken = process.env.CONSOLE_WRITE_ADMIN_TOKEN;
    const originalLegacyToken = process.env.GITBOARD_SOURCES_ADMIN_TOKEN;
    const db = createXtrmDatabase(":memory:");
    const triggered: Array<string | null | undefined> = [];
    const app = new Hono();
    app.route("/api/console/graph", createGraphRouter(createXtrmGraphRoute(db, (projectId) => triggered.push(projectId))));

    try {
      const forbidden = await app.fetch(new Request("http://localhost/api/console/graph/invalidate", {
        method: "POST",
        headers: { "Content-Type": "application/json", host: "localhost" },
        body: JSON.stringify({ project_id: "repo-a" }),
      }));
      expect(forbidden.status).toBe(403);

      process.env.CONSOLE_WRITE_ADMIN_TOKEN = "primary-secret";
      delete process.env.GITBOARD_SOURCES_ADMIN_TOKEN;
      const primaryAllowed = await app.fetch(new Request("http://localhost/api/console/graph/invalidate", {
        method: "POST",
        headers: { "Content-Type": "application/json", host: "localhost", "x-console-write-token": "primary-secret" },
        body: JSON.stringify({ project_id: "repo-a" }),
      }));
      expect(primaryAllowed.status).toBe(200);

      delete process.env.CONSOLE_WRITE_ADMIN_TOKEN;
      process.env.GITBOARD_SOURCES_ADMIN_TOKEN = "legacy-secret";
      const legacyAllowed = await app.fetch(new Request("http://localhost/api/console/graph/invalidate", {
        method: "POST",
        headers: { "Content-Type": "application/json", host: "localhost", "x-gitboard-sources-admin-token": "legacy-secret" },
        body: JSON.stringify({ project_id: "repo-b" }),
      }));
      expect(legacyAllowed.status).toBe(200);

      delete process.env.CONSOLE_WRITE_ADMIN_TOKEN;
      delete process.env.GITBOARD_SOURCES_ADMIN_TOKEN;
      const sameOriginAllowed = await app.fetch(new Request("http://localhost/api/console/graph/invalidate", {
        method: "POST",
        headers: { "Content-Type": "application/json", host: "localhost", origin: "http://localhost" },
        body: JSON.stringify({ project_id: "repo-c" }),
      }));
      expect(sameOriginAllowed.status).toBe(200);
      expect(triggered).toEqual(["repo-a", "repo-b", "repo-c"]);

      const cooldown = await app.fetch(new Request("http://localhost/api/console/graph/invalidate", {
        method: "POST",
        headers: { "Content-Type": "application/json", host: "localhost", origin: "http://localhost" },
        body: JSON.stringify({ project_id: "repo-c" }),
      }));
      expect(cooldown.status).toBe(429);
    } finally {
      if (originalPrimaryToken === undefined) delete process.env.CONSOLE_WRITE_ADMIN_TOKEN;
      else process.env.CONSOLE_WRITE_ADMIN_TOKEN = originalPrimaryToken;
      if (originalLegacyToken === undefined) delete process.env.GITBOARD_SOURCES_ADMIN_TOKEN;
      else process.env.GITBOARD_SOURCES_ADMIN_TOKEN = originalLegacyToken;
      db.close();
    }
  });

  it("keeps invalidate cooldown state isolated per router instance", async () => {
    const originalToken = process.env.CONSOLE_WRITE_ADMIN_TOKEN;
    process.env.CONSOLE_WRITE_ADMIN_TOKEN = "primary-secret";
    const db = createXtrmDatabase(":memory:");
    const route = createXtrmGraphRoute(db, () => {});
    const firstRouter = createGraphRouter(route);
    const secondRouter = createGraphRouter(route);
    const request = () => new Request("http://localhost/invalidate", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost", "x-console-write-token": "primary-secret" },
      body: JSON.stringify({ project_id: "repo-a" }),
    });

    try {
      expect((await firstRouter.fetch(request())).status).toBe(200);
      expect((await firstRouter.fetch(request())).status).toBe(429);
      expect((await secondRouter.fetch(request())).status).toBe(200);
    } finally {
      if (originalToken === undefined) delete process.env.CONSOLE_WRITE_ADMIN_TOKEN;
      else process.env.CONSOLE_WRITE_ADMIN_TOKEN = originalToken;
      db.close();
    }
  });

  it("returns unavailable when no materializer invalidator is wired", async () => {
    const originalToken = process.env.CONSOLE_WRITE_ADMIN_TOKEN;
    process.env.CONSOLE_WRITE_ADMIN_TOKEN = "primary-secret";
    const db = createXtrmDatabase(":memory:");
    const app = createGraphRouter(createXtrmGraphRoute(db));
    try {
      const response = await app.fetch(new Request("http://localhost/invalidate", {
        method: "POST",
        headers: { "Content-Type": "application/json", host: "localhost", "x-console-write-token": "primary-secret" },
        body: JSON.stringify({ project_id: "repo-a" }),
      }));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "graph invalidation unavailable" });
    } finally {
      if (originalToken === undefined) delete process.env.CONSOLE_WRITE_ADMIN_TOKEN;
      else process.env.CONSOLE_WRITE_ADMIN_TOKEN = originalToken;
      db.close();
    }
  });

  it("rejects invalid invalidate project keys", async () => {
    const originalToken = process.env.CONSOLE_WRITE_ADMIN_TOKEN;
    process.env.CONSOLE_WRITE_ADMIN_TOKEN = "primary-secret";
    const db = createXtrmDatabase(":memory:");
    const app = createGraphRouter(createXtrmGraphRoute(db, () => {}));
    try {
      for (const projectId of ["-repo", "repo/a", "repo a", "x".repeat(257), { nested: true }]) {
        const response = await app.fetch(new Request("http://localhost/invalidate", {
          method: "POST",
          headers: { "Content-Type": "application/json", host: "localhost", "x-console-write-token": "primary-secret" },
          body: JSON.stringify({ project_id: projectId }),
        }));
        expect(response.status, JSON.stringify(projectId)).toBe(400);
      }
    } finally {
      if (originalToken === undefined) delete process.env.CONSOLE_WRITE_ADMIN_TOKEN;
      else process.env.CONSOLE_WRITE_ADMIN_TOKEN = originalToken;
      db.close();
    }
  });
});
