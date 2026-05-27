import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createGraphDao } from "../../../src/core/graph-dao.ts";
import { createGraphRouter } from "../../../src/api/routes/graph.ts";
import { createXtrmDatabase } from "../../../src/core/xtrm-store.ts";

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
    const json = await response.json() as { freshness: string; source_health: { status: string; metadata?: Record<string, unknown> }; nodes: Array<{ id: string }> };

    expect(response.status).toBe(200);
    expect(triggered).toEqual([]);
    expect(json.freshness).toBe("fresh");
    expect(json.source_health.status).toBe("degraded");
    expect(json.source_health.metadata).toEqual(expect.objectContaining({ last_status: "error" }));
    expect(json.source_health.metadata).not.toHaveProperty("source_key");
    expect(json.nodes.map((node) => node.id)).toEqual(["A"]);

    db.close();
  });

  it("protects POST invalidate and triggers materializer for allowed local origins", async () => {
    const db = createXtrmDatabase(":memory:");
    const triggered: Array<string | null | undefined> = [];
    const app = new Hono();
    app.route("/api/console/graph", createGraphRouter(createGraphDao({ xtrmDb: db, triggerMaterialization: (projectId) => triggered.push(projectId) })));

    const forbidden = await app.fetch(new Request("http://localhost/api/console/graph/invalidate", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost" },
      body: JSON.stringify({ project_id: "repo-a" }),
    }));
    expect(forbidden.status).toBe(403);

    const allowed = await app.fetch(new Request("http://localhost/api/console/graph/invalidate", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost", origin: "http://localhost" },
      body: JSON.stringify({ project_id: "repo-a" }),
    }));
    expect(allowed.status).toBe(200);
    expect(triggered).toEqual(["repo-a"]);

    const cooldown = await app.fetch(new Request("http://localhost/api/console/graph/invalidate", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost", origin: "http://localhost" },
      body: JSON.stringify({ project_id: "repo-a" }),
    }));
    expect(cooldown.status).toBe(429);

    db.close();
  });
});
