import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createInternalParityRouter } from "../../../src/server/routes/internal-parity.ts";
import type { ParitySummary } from "../../../../../packages/core/src/observability/parity.ts";

describe("internal observability parity security", () => {
  it("returns fingerprinted diffs without raw specialist output", async () => {
    const secret = "specialist-terminal-secret";
    const latest: ParitySummary = {
      started_at: "2026-07-23T00:00:00.000Z",
      finished_at: "2026-07-23T00:00:01.000Z",
      parity_ok_count: 0,
      diff_count: 1,
      checks: { "jobsByBead:bead-1": { live: 1, shadow: 1, diffs: 1 } },
      diffs: [{
        check: "jobsByBead",
        scope: "bead-1",
        kind: "field_delta",
        severity: "warn",
        path: "repo::job-1::bead-1::done::date.lastOutput",
        live: secret,
        shadow: "different result",
      }],
    };
    const router = createInternalParityRouter(() => ({ getParityOkCount: () => 0, getLatestSummary: () => latest }));
    const app = new Hono().route("/api/internal", router);

    const response = await app.request("http://localhost/api/internal/parity/observability", {
      headers: { host: "localhost", "x-xtrm-peer-address": "127.0.0.1" },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(JSON.stringify(body)).not.toContain("different result");
    expect(body.latest_summary.diffs[0]).toMatchObject({
      path: expect.stringMatching(/lastOutput$/),
      live: { type: "string", length: secret.length, sha256: expect.stringMatching(/^[a-f0-9]{16}$/) },
    });
  });
});
