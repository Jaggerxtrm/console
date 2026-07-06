import { afterEach, describe, expect, it } from "vitest";
import {
  canRefreshSources,
  createSourceRefreshState,
  formatSourceDisplayPath,
  isAllowedConsoleWriteRequest,
  isAllowedMutationRequest,
  isAllowedSourceKind,
} from "../../../src/api/routes/sources-policy.ts";

const originalPrimaryToken = process.env.CONSOLE_WRITE_ADMIN_TOKEN;
const originalLegacyToken = process.env.GITBOARD_SOURCES_ADMIN_TOKEN;

afterEach(() => {
  if (originalPrimaryToken === undefined) delete process.env.CONSOLE_WRITE_ADMIN_TOKEN;
  else process.env.CONSOLE_WRITE_ADMIN_TOKEN = originalPrimaryToken;

  if (originalLegacyToken === undefined) delete process.env.GITBOARD_SOURCES_ADMIN_TOKEN;
  else process.env.GITBOARD_SOURCES_ADMIN_TOKEN = originalLegacyToken;
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

  it("accepts same-origin localhost requests", () => {
    expect(isAllowedConsoleWriteRequest("http://localhost/pin", "localhost", "http://localhost", null, process.env)).toBe(true);
  });

  it("rejects remote host even with origin token", () => {
    process.env.CONSOLE_WRITE_ADMIN_TOKEN = "secret";
    expect(isAllowedConsoleWriteRequest("http://localhost/pin", "evil.com", "http://localhost", "secret", process.env)).toBe(false);
  });

  it("rejects no-origin requests without valid token", () => {
    delete process.env.CONSOLE_WRITE_ADMIN_TOKEN;
    delete process.env.GITBOARD_SOURCES_ADMIN_TOKEN;
    expect(isAllowedConsoleWriteRequest("http://localhost/pin", "localhost", null, null, process.env)).toBe(false);
  });

  it("accepts primary env/header token pair", () => {
    process.env.CONSOLE_WRITE_ADMIN_TOKEN = "secret";
    expect(isAllowedConsoleWriteRequest("http://localhost/pin", "localhost", null, "secret", process.env)).toBe(true);
  });

  it("accepts legacy env/header token pair", () => {
    process.env.GITBOARD_SOURCES_ADMIN_TOKEN = "legacy";
    expect(isAllowedConsoleWriteRequest("http://localhost/pin", "localhost", null, "legacy", process.env)).toBe(true);
  });

  it("rejects wrong token", () => {
    process.env.CONSOLE_WRITE_ADMIN_TOKEN = "secret";
    expect(isAllowedConsoleWriteRequest("http://localhost/pin", "localhost", null, "wrong", process.env)).toBe(false);
  });

  it("rejects malformed origin", () => {
    expect(isAllowedConsoleWriteRequest("http://localhost/pin", "localhost", "http://[::1", null, process.env)).toBe(false);
  });

  it("keeps compatibility wrapper", () => {
    process.env.CONSOLE_WRITE_ADMIN_TOKEN = "secret";
    expect(isAllowedMutationRequest("http://localhost/pin", "localhost", null, "secret")).toBe(true);
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
