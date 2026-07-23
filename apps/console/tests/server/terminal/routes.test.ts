import { describe, expect, it, vi } from "vitest";
import type { TerminalProviderRegistry } from "../../../../../packages/core/src/terminal/provider-registry.ts";
import { createShellRouter } from "../../../src/server/routes/shell.ts";
import { createTerminalRouter } from "../../../src/server/routes/terminal.ts";
import { createTerminalTicketRegistry, TERMINAL_TICKET_COOKIE } from "../../../src/server/terminal/tickets.ts";

const ENABLED_ENV = {
  NODE_ENV: "production",
  HOST: "localhost",
  GITBOARD_SHELL_PROVIDER_ENABLED: "1",
  GITBOARD_SHELL_PROVIDER_ALLOW_REMOTE: "1",
  GITBOARD_SHELL_PROVIDER_DEV_GATE: "0",
  GITBOARD_SHELL_PROVIDER_ADMIN_ONLY: "1",
  GITBOARD_SHELL_PROVIDER_ADMIN_TOKEN: "terminal-admin-secret",
} as NodeJS.ProcessEnv;

describe("Console terminal HTTP routes", () => {
  it("preserves the disabled shell status and websocket fallback", async () => {
    const app = createShellRouter({
      NODE_ENV: "production",
      GITBOARD_SHELL_PROVIDER_CWD_ALLOWLIST: "/repo",
      GITBOARD_SHELL_PROVIDER_SHELL_ALLOWLIST: "/bin/sh",
      GITBOARD_SHELL_PROVIDER_ENV_SCRUB: "SECRET_TOKEN",
      GITBOARD_SHELL_PROVIDER_MAX_SESSIONS: "2",
      GITBOARD_SHELL_PROVIDER_IDLE_TIMEOUT_MS: "1000",
      GITBOARD_SHELL_PROVIDER_HARD_TTL_MS: "2000",
      GITBOARD_SHELL_PROVIDER_MAX_INPUT_BPS: "128",
      GITBOARD_SHELL_PROVIDER_MAX_OUTPUT_BPS: "256",
    } as NodeJS.ProcessEnv);

    const status = await app.request("/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      enabled: false,
      disabledReason: "shell provider disabled by default",
      message: "shell provider disabled by default; provider stays off until explicit env/admin enablement",
      policy: {
        enabled: false,
        allowRemote: false,
        allowAdminOnly: true,
        devGateRequired: true,
        cwdAllowlist: ["/repo"],
        shellAllowlist: ["/bin/sh"],
        envScrub: ["SECRET_TOKEN"],
        maxSessions: 2,
        idleTimeoutMs: 1000,
        hardTtlMs: 2000,
        maxInputBytesPerSecond: 128,
        maxOutputBytesPerSecond: 256,
        auditEnabled: true,
        orphanCleanupEnabled: true,
      },
    });

    const websocket = await app.request("/ws");
    expect(websocket.status).toBe(403);
    expect(await websocket.json()).toEqual({ error: "shell provider disabled by default" });
  });

  it("preserves the enabled HTTP fallback as not implemented", async () => {
    const app = createShellRouter({
      NODE_ENV: "development",
      HOST: "localhost",
      GITBOARD_SHELL_PROVIDER_ENABLED: "1",
      GITBOARD_SHELL_PROVIDER_DEV_GATE: "0",
      GITBOARD_SHELL_PROVIDER_ADMIN_ONLY: "0",
    } as NodeJS.ProcessEnv);

    const response = await app.request("/ws");
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error: "shell provider not implemented" });
  });

  it("lists provider status without opening a session", async () => {
    const providers: TerminalProviderRegistry = {
      list: vi.fn((): ReturnType<TerminalProviderRegistry["list"]> => [
        { kind: "specialist-feed", enabled: false, reason: "verified admin required for specialist feed" },
        { kind: "pty", enabled: false, reason: "shell provider disabled by default" },
      ]),
      get: vi.fn(),
    };
    const app = createTerminalRouter(providers);

    const response = await app.request("/status");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ providers: [
      { kind: "specialist-feed", enabled: false, reason: "verified admin required for specialist feed" },
      { kind: "pty", enabled: false, reason: "shell provider disabled by default" },
    ] });
    expect(providers.get).not.toHaveBeenCalled();
  });

  it("issues a browser-compatible HttpOnly ticket without exposing it in the response body", async () => {
    const providers: TerminalProviderRegistry = { list: () => [], get: () => undefined };
    const tickets = createTerminalTicketRegistry({ ttlMs: 30_000 });
    const app = createTerminalRouter(providers, { env: ENABLED_ENV, tickets });
    const response = await app.request("http://localhost/ticket", {
      method: "POST",
      headers: {
        host: "localhost",
        origin: "http://localhost",
        "x-gitboard-shell-token": "terminal-admin-secret",
      },
    });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${TERMINAL_TICKET_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/api/console/terminal/ws");
    expect(cookie).not.toContain("terminal-admin-secret");
    expect(tickets.consume(cookie.split(";")[0] ?? null)).toEqual({ isVerifiedAdmin: true });
  });

  it("denies ticket issuance without admin proof or from a hostile origin", async () => {
    const providers: TerminalProviderRegistry = { list: () => [], get: () => undefined };
    const app = createTerminalRouter(providers, {
      env: ENABLED_ENV,
      tickets: createTerminalTicketRegistry(),
    });
    const request = (origin: string, token?: string) => app.request("http://localhost/ticket", {
      method: "POST",
      headers: {
        host: "localhost",
        origin,
        ...(token ? { "x-gitboard-shell-token": token } : {}),
      },
    });

    const noAdmin = await request("http://localhost");
    const hostile = await request("https://hostile.invalid", "terminal-admin-secret");
    expect(noAdmin.status).toBe(403);
    expect(hostile.status).toBe(403);
    expect(noAdmin.headers.get("set-cookie")).toBeNull();
    expect(hostile.headers.get("set-cookie")).toBeNull();
  });
});
