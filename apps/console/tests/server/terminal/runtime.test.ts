import { describe, expect, it, vi } from "vitest";
import { createHostLogger } from "../../../src/server/log.ts";
import { createConsoleTerminal } from "../../../src/server/terminal/runtime.ts";

const ENABLED_ENV = {
  NODE_ENV: "production",
  HOST: "localhost",
  GITBOARD_SHELL_PROVIDER_ENABLED: "1",
  GITBOARD_SHELL_PROVIDER_ALLOW_REMOTE: "1",
  GITBOARD_SHELL_PROVIDER_DEV_GATE: "0",
  GITBOARD_SHELL_PROVIDER_ADMIN_ONLY: "1",
  GITBOARD_SHELL_PROVIDER_ADMIN_TOKEN: "terminal-admin-secret",
} as NodeJS.ProcessEnv;

describe("Console terminal WebSocket runtime", () => {
  it("rejects no-admin, bad-token, hostile-origin, and spoofed localhost upgrades", async () => {
    const sink: string[] = [];
    const logger = createHostLogger({ sink: (line) => sink.push(line), diskEnabled: false });
    const terminal = createConsoleTerminal({ logger, env: ENABLED_ENV });
    const server = { upgrade: vi.fn(() => true) };
    const request = (origin: string, token?: string) => new Request("http://localhost/api/console/terminal/ws", {
      headers: {
        host: "localhost",
        origin,
        upgrade: "websocket",
        ...(token ? { "x-gitboard-shell-token": token } : {}),
      },
    });

    const noAdmin = terminal.handleUpgrade(request("http://localhost"), server as never, "127.0.0.1") as Response;
    const badToken = terminal.handleUpgrade(request("http://localhost", "wrong"), server as never, "127.0.0.1") as Response;
    const hostile = terminal.handleUpgrade(request("https://hostile.invalid", "terminal-admin-secret"), server as never, "127.0.0.1") as Response;
    const malformed = terminal.handleUpgrade(request("malformed-origin-terminal-secret", "terminal-admin-secret"), server as never, "127.0.0.1") as Response;
    const spoofed = terminal.handleUpgrade(request("http://localhost", "terminal-admin-secret"), server as never, "203.0.113.8") as Response;

    for (const response of [noAdmin, badToken, hostile, malformed, spoofed]) {
      expect(response.status).toBe(403);
      expect(response.headers.get("content-type")).toContain("application/json");
    }
    await expect(noAdmin.json()).resolves.toEqual({ error: "admin-only shell access requires verified admin" });
    await expect(badToken.json()).resolves.toEqual({ error: "admin-only shell access requires verified admin" });
    await expect(hostile.json()).resolves.toEqual({ error: "shell websocket origin denied" });
    await expect(malformed.json()).resolves.toEqual({ error: "shell websocket origin denied" });
    await expect(spoofed.json()).resolves.toEqual({ error: "loopback host denied" });
    expect(server.upgrade).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.getRing())).not.toContain("terminal-admin-secret");
    expect(`${sink.join("\n")}\n${JSON.stringify(logger.getRing())}`).not.toContain("malformed-origin-terminal-secret");
  });

  it("upgrades a same-origin verified admin without logging the token", () => {
    const logger = createHostLogger({ sink: () => {}, diskEnabled: false });
    const terminal = createConsoleTerminal({ logger, env: ENABLED_ENV });
    const server = { upgrade: vi.fn(() => true) };
    const request = new Request("http://localhost/api/console/terminal/ws", {
      headers: {
        host: "localhost",
        origin: "http://localhost",
        upgrade: "websocket",
        "x-gitboard-shell-token": "terminal-admin-secret",
      },
    });

    expect(terminal.handleUpgrade(request, server as never, "127.0.0.1")).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledWith(request, { data: expect.objectContaining({ path: "/api/console/terminal/ws" }) });
    expect(JSON.stringify(logger.getRing())).not.toContain("terminal-admin-secret");
  });

  it("accepts a browser ticket once and does not let a hostile origin consume it", () => {
    const logger = createHostLogger({ sink: () => {}, diskEnabled: false });
    const terminal = createConsoleTerminal({ logger, env: ENABLED_ENV });
    const server = { upgrade: vi.fn(() => true) };
    const issued = terminal.tickets.issue({ isVerifiedAdmin: true });
    const request = (origin: string) => new Request("http://localhost/api/console/terminal/ws", {
      headers: {
        host: "localhost",
        origin,
        upgrade: "websocket",
        cookie: `xtrm_terminal_ticket=${issued.ticket}`,
      },
    });

    const hostile = terminal.handleUpgrade(request("https://hostile.invalid"), server as never, "127.0.0.1") as Response;
    expect(hostile.status).toBe(403);
    expect(terminal.handleUpgrade(request("http://localhost"), server as never, "127.0.0.1")).toBeUndefined();
    const replay = terminal.handleUpgrade(request("http://localhost"), server as never, "127.0.0.1") as Response;
    expect(replay.status).toBe(403);
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });
});
