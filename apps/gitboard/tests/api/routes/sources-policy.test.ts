import { afterEach, describe, expect, it } from "vitest";
import { canRefreshSources, createSourceRefreshState, formatSourceDisplayPath, isAllowedMutationRequest, isAllowedSourceKind } from "../../../src/api/routes/sources-policy.ts";

const originalAdminToken = process.env.GITBOARD_SOURCES_ADMIN_TOKEN;

afterEach(() => {
  if (originalAdminToken === undefined) delete process.env.GITBOARD_SOURCES_ADMIN_TOKEN;
  else process.env.GITBOARD_SOURCES_ADMIN_TOKEN = originalAdminToken;
});

describe("sources policy helpers", () => {
  it("redacts display paths", () => {
    expect(formatSourceDisplayPath("/very/private/workspace/demo/.beads")).toBe("…/demo/.beads");
  });

  it("allows only known kinds", () => {
    expect(isAllowedSourceKind("beads")).toBe(true);
    expect(isAllowedSourceKind("observability")).toBe(true);
    expect(isAllowedSourceKind("unknown")).toBe(false);
  });

  it("rejects cross-origin, spoofed, and no-origin requests without token", () => {
    delete process.env.GITBOARD_SOURCES_ADMIN_TOKEN;
    expect(isAllowedMutationRequest("http://localhost/pin", "localhost", null, null)).toBe(false);
    expect(isAllowedMutationRequest("http://example.com/pin", "localhost", null, null)).toBe(false);
    expect(isAllowedMutationRequest("http://localhost/pin", "localhost", "https://example.com", null)).toBe(false);
  });

  it("allows no-origin mutation only with admin token", () => {
    process.env.GITBOARD_SOURCES_ADMIN_TOKEN = "secret";
    expect(isAllowedMutationRequest("http://localhost/pin", "localhost", null, "secret")).toBe(true);
  });

  it("allows same-origin local mutation", () => {
    expect(isAllowedMutationRequest("http://localhost/pin", "localhost", "http://localhost", null)).toBe(true);
  });

  it("rate-limits repeat refresh calls", () => {
    const state = createSourceRefreshState();
    state.lastCompletedAt = Date.now();
    const gate = canRefreshSources(Date.now(), state);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.status).toBe(429);
  });

  it("reports in-flight refresh as 202", () => {
    const state = createSourceRefreshState();
    state.inFlight = Promise.resolve();
    const gate = canRefreshSources(Date.now(), state);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.status).toBe(202);
  });
});
