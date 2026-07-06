import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createGraphDao } from "../../../src/core/graph-dao.ts";
import { createGraphRouter } from "../../../src/api/routes/graph.ts";
import { createXtrmDatabase } from "../../../src/core/xtrm-store.ts";
import { readXtrmGraphSnapshot } from "../../../../../packages/core/src/state/index.ts";

describe("graph route xtrm source", () => {
  it("surfaces xtrm graph health without letting GET refresh trigger materializer", async () => {
    const db = createXtrmDatabase(":memory:");
    const triggered: Array<string | null | undefined> = [];
    db.query("INSERT INTO sources (source_key, kind, path, origin, status) VALUES ('beads:repo-a', 'beads', '/tmp/repo-a/.beads', 'discovered', 'active')").run();
    db.query("INSERT INTO substrate_issues (repo_slug, issue_id, title, state, priority, issue_type) VALUES ('repo-a', 'A', 'Alpha', 'open', 1, 'task')").run();
    db.query("INSERT INTO materialization_state (source_key, last_success_at, last_status, last_error) VALUES ('beads:repo-a', CURRENT_TIMESTAMP, 'error', 'source offline')").run();

    const app = new Hono();
    app.route("/api/console/graph", createGraphRouter(createGraphDao({ xtrmDb: db, triggerMaterialization: (projectId) => triggered.push(projectId) })));

    const response = await app.fetch(new Request("http://localhost/api/console/graph?project=repo-a&refresh=true"));
    const json = await response.json() as {
      freshness: string;
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
    expect(coreSnapshot.sourceHealth).toBeDefined();
    expect(json.source_health.status).toEqual(coreSnapshot.sourceHealth?.status);
    expect(json.source_health.message).toEqual(coreSnapshot.sourceHealth?.message);
    expect(json.source_health.metadata).toEqual(coreSnapshot.sourceHealth?.metadata);
    expect(json.nodes.map((node) => node.id)).toEqual(["A"]);

    db.close();
  });

  it("protects POST invalidate and accepts primary token with legacy fallback", async () => {
    const originalPrimaryToken = process.env.CONSOLE_WRITE_ADMIN_TOKEN;
    const originalLegacyToken = process.env.GITBOARD_SOURCES_ADMIN_TOKEN;
    const db = createXtrmDatabase(":memory:");
    const triggered: Array<string | null | undefined> = [];
    const app = new Hono();
    app.route("/api/console/graph", createGraphRouter(createGraphDao({ xtrmDb: db, triggerMaterialization: (projectId) => triggered.push(projectId) })));

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
});
