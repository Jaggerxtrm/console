import { afterEach, describe, expect, it } from "vitest";
import {
  isAllowedConsoleWriteRequest,
  isAllowedMutationRequest,
  isLocalhost,
} from "../src/runtime/console-write-policy.ts";

const originalPrimaryToken = process.env.CONSOLE_WRITE_ADMIN_TOKEN;
const originalLegacyToken = process.env.GITBOARD_SOURCES_ADMIN_TOKEN;

afterEach(() => {
  restoreEnv("CONSOLE_WRITE_ADMIN_TOKEN", originalPrimaryToken);
  restoreEnv("GITBOARD_SOURCES_ADMIN_TOKEN", originalLegacyToken);
});

describe("console write policy", () => {
  it.each([
    "localhost",
    "LOCALHOST:3030",
    "127.0.0.1:3030",
    "[::1]",
    "[::1]:3030",
    "http://localhost:3030",
  ])("recognizes normalized localhost host %s", (host) => {
    expect(isLocalhost(host)).toBe(true);
  });

  it.each([
    "localhost.attacker.tld",
    "127.0.0.1.attacker.tld",
    "[::1].attacker.tld",
    "evil.test:3030",
    "",
  ])("rejects non-local host %s", (host) => {
    expect(isLocalhost(host)).toBe(false);
  });

  it.each([
    ["http://localhost/pin", "localhost", "http://localhost"],
    ["https://localhost:3443/pin", "localhost:3443", "https://localhost:3443"],
    ["http://[::1]/pin", "[::1]", "http://[::1]"],
  ])("accepts a same-origin localhost request", (url, host, origin) => {
    expect(isAllowedConsoleWriteRequest(url, host, origin, null, {})).toBe(true);
  });

  it.each([
    ["http://localhost/pin", "localhost", "https://localhost"],
    ["http://localhost:3030/pin", "localhost:3030", "http://localhost:3031"],
    ["http://localhost/pin", "localhost", "http://127.0.0.1"],
    ["http://localhost/pin", "evil.test", "http://localhost"],
    ["http://evil.test/pin", "localhost", "http://evil.test"],
    ["http://localhost/pin", "localhost.attacker.tld", "http://localhost"],
    ["http://localhost/pin", "localhost", "http://[::1"],
  ])("rejects cross-origin, remote, and malformed requests", (url, host, origin) => {
    expect(isAllowedConsoleWriteRequest(url, host, origin, "secret", {
      CONSOLE_WRITE_ADMIN_TOKEN: "secret",
    })).toBe(false);
  });

  it("requires an exact configured token when Origin is absent", () => {
    const env = { CONSOLE_WRITE_ADMIN_TOKEN: "secret" };
    expect(isAllowedConsoleWriteRequest("http://localhost/pin", "localhost", null, "secret", env)).toBe(true);
    expect(isAllowedConsoleWriteRequest("http://localhost/pin", "localhost", null, "Secret", env)).toBe(false);
    expect(isAllowedConsoleWriteRequest("http://localhost/pin", "localhost", null, null, env)).toBe(false);
  });

  it("keeps primary-over-legacy token precedence, including an empty primary token", () => {
    expect(isAllowedConsoleWriteRequest("http://localhost/pin", "localhost", null, "legacy", {
      GITBOARD_SOURCES_ADMIN_TOKEN: "legacy",
    })).toBe(true);
    expect(isAllowedConsoleWriteRequest("http://localhost/pin", "localhost", null, "legacy", {
      CONSOLE_WRITE_ADMIN_TOKEN: "primary",
      GITBOARD_SOURCES_ADMIN_TOKEN: "legacy",
    })).toBe(false);
    expect(isAllowedConsoleWriteRequest("http://localhost/pin", "localhost", null, "legacy", {
      CONSOLE_WRITE_ADMIN_TOKEN: "",
      GITBOARD_SOURCES_ADMIN_TOKEN: "legacy",
    })).toBe(false);
  });

  it("ignores tokens for valid same-origin requests", () => {
    expect(isAllowedConsoleWriteRequest(
      "http://localhost/pin",
      "localhost",
      "http://localhost",
      "wrong",
      { CONSOLE_WRITE_ADMIN_TOKEN: "secret" },
    )).toBe(true);
  });

  it("rejects a localhost Host/Origin pair when the trusted peer is remote", () => {
    expect(isAllowedConsoleWriteRequest(
      "http://localhost/pin",
      "localhost",
      "http://localhost",
      null,
      {},
      "203.0.113.20",
    )).toBe(false);
    expect(isAllowedConsoleWriteRequest(
      "http://localhost/pin",
      "localhost",
      "http://localhost",
      null,
      {},
      "::ffff:127.0.0.1",
    )).toBe(true);
  });

  it("keeps the process-env compatibility wrapper", () => {
    process.env.CONSOLE_WRITE_ADMIN_TOKEN = "secret";
    expect(isAllowedMutationRequest("http://localhost/pin", "localhost", null, "secret")).toBe(true);
  });

  it("preserves invalid request URL errors", () => {
    expect(() => isAllowedConsoleWriteRequest("not a url", "localhost", null, null, {})).toThrow();
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
