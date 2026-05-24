import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createInternalVerifyRouter } from "../../../src/api/routes/internal-verify.ts";

describe("internal verify route", () => {
  it("gates to localhost", async () => {
    const router = createInternalVerifyRouter();
    const app = new Hono().route("/api/internal", router);
    const res = await app.request("http://example.com/api/internal/verify-runtime", { headers: { host: "example.com" } });
    expect(res.status).toBe(403);
  });
});
