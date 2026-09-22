import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createRuntimeObservabilityRouter, type RuntimeObservabilityRunner } from "../../../src/server/routes/runtime-observability.ts";

describe("runtime observability route", () => {
  it("returns topology and bounded xtmux journal data from the read-only runner", async () => {
    const calls: string[][] = [];
    const runner: RuntimeObservabilityRunner = {
      async run(args) {
        calls.push([...args]);
        if (args[0] === "topology") return JSON.stringify({ schema_version: "xtrm.xtmux.topology.v1", sessions: [] });
        return JSON.stringify([{ createdAtMs: 100, type: "agent.ready", paneId: "%1" }]);
      },
    };
    const app = new Hono();
    app.route("/api/console/runtime", createRuntimeObservabilityRouter({ runner, now: () => 1234 }));

    const response = await app.request("http://localhost/api/console/runtime/overview?event_limit=9999");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      schema_version: "xtrm.console.runtime-observability.v1",
      generated_at_ms: 1234,
      topology: { schema_version: "xtrm.xtmux.topology.v1", sessions: [] },
      events: [{ type: "agent.ready", paneId: "%1" }],
      source_health: { topology: { status: "ok" }, journal: { status: "ok" } },
    });
    expect(calls).toEqual([["topology", "--json"], ["log-tail", "500", "--json"]]);
  });

  it("degrades one source without hiding healthy runtime topology", async () => {
    const runner: RuntimeObservabilityRunner = {
      async run(args) {
        if (args[0] === "topology") return JSON.stringify({ sessions: [{ session_id: "$1", windows: [] }] });
        throw new Error("journal unavailable");
      },
    };
    const app = new Hono();
    app.route("/api/console/runtime", createRuntimeObservabilityRouter({ runner }));

    const response = await app.request("http://localhost/api/console/runtime/overview");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      topology: { sessions: [{ session_id: "$1" }] },
      events: [],
      source_health: { topology: { status: "ok" }, journal: { status: "degraded", error: "journal unavailable" } },
    });
  });
});
