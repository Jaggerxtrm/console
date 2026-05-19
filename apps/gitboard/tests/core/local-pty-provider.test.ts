import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalPtyProvider, type PtyFactory, type PtyLike } from "../../src/core/local-pty-provider.ts";
import { getShellProviderStatus, parseShellProviderPolicy } from "../../src/core/shell-provider-policy.ts";

class MockPty implements PtyLike {
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  kills: string[] = [];
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: { exitCode: number | null; signal: number | null }) => void> = [];

  write(data: string): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.resizes.push([cols, rows]); }
  kill(signal?: string): void { this.kills.push(signal ?? "SIGTERM"); }
  onData(listener: (data: string) => void): void { this.dataListeners.push(listener); }
  onExit(listener: (event: { exitCode: number | null; signal: number | null }) => void): void { this.exitListeners.push(listener); }

  emitData(data: string): void { for (const listener of this.dataListeners) listener(data); }
  emitExit(event: { exitCode: number | null; signal: number | null }): void { for (const listener of this.exitListeners) listener(event); }
}

function createProvider(factory?: PtyFactory) {
  const policy = parseShellProviderPolicy({
    GITBOARD_SHELL_PROVIDER_ENABLED: "1",
    GITBOARD_SHELL_PROVIDER_ALLOW_REMOTE: "1",
    GITBOARD_SHELL_PROVIDER_DEV_GATE: "0",
    GITBOARD_SHELL_PROVIDER_ADMIN_ONLY: "0",
    GITBOARD_SHELL_PROVIDER_CWD_ALLOWLIST: "/repo",
    GITBOARD_SHELL_PROVIDER_SHELL_ALLOWLIST: "/bin/bash,/bin/zsh",
    GITBOARD_SHELL_PROVIDER_MAX_SESSIONS: "2",
    GITBOARD_SHELL_PROVIDER_IDLE_TIMEOUT_MS: "1000",
    GITBOARD_SHELL_PROVIDER_HARD_TTL_MS: "5000",
  } as NodeJS.ProcessEnv);
  const status = getShellProviderStatus({
    NODE_ENV: "development",
    HOST: "localhost",
    GITBOARD_SHELL_PROVIDER_ENABLED: "1",
    GITBOARD_SHELL_PROVIDER_ALLOW_REMOTE: "1",
    GITBOARD_SHELL_PROVIDER_DEV_GATE: "0",
    GITBOARD_SHELL_PROVIDER_ADMIN_ONLY: "0",
    GITBOARD_SHELL_PROVIDER_CWD_ALLOWLIST: "/repo",
    GITBOARD_SHELL_PROVIDER_SHELL_ALLOWLIST: "/bin/bash,/bin/zsh",
    GITBOARD_SHELL_PROVIDER_MAX_SESSIONS: "2",
    GITBOARD_SHELL_PROVIDER_IDLE_TIMEOUT_MS: "1000",
    GITBOARD_SHELL_PROVIDER_HARD_TTL_MS: "5000",
  } as NodeJS.ProcessEnv, { isVerifiedAdmin: true });
  return new LocalPtyProvider({ policy, status, workspaceRoot: "/repo", ptyFactory: factory });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("LocalPtyProvider", () => {
  it("creates session, writes, resizes, and emits output", () => {
    const pty = new MockPty();
    const provider = createProvider({ create: () => pty });
    const output: Array<{ sessionId: string; data: string }> = [];
    provider.on("output", (event) => output.push(event));

    const session = provider.createSession({ cwd: ".", shell: "/bin/bash" });
    expect(session.cwd).toBe("/repo");
    expect(session.shell).toBe("/bin/bash");

    session.write("echo hi\n");
    session.resize(120, 40);
    pty.emitData("hi\n");

    expect(pty.writes).toEqual(["echo hi\n"]);
    expect(pty.resizes).toEqual([[120, 40]]);
    expect(output).toEqual([{ sessionId: session.id, data: "hi\n" }]);
  });

  it("resolves shell from request and cwd inside workspace root", () => {
    const pty = new MockPty();
    const created: Array<{ cwd: string; shell: string }> = [];
    const provider = createProvider({ create: (options) => { created.push(options); return pty; } });

    const session = provider.createSession({ cwd: "service", shell: "/bin/zsh" });

    expect(session.cwd).toBe("/repo/service");
    expect(session.shell).toBe("/bin/zsh");
    expect(created).toEqual([{ cwd: "/repo/service", shell: "/bin/zsh", cols: 80, rows: 24 }]);
  });

  it("rejects cwd outside allowlist and shell outside allowlist", () => {
    const provider = createProvider({ create: () => new MockPty() });

    expect(() => provider.createSession({ cwd: "/tmp", shell: "/bin/bash" })).toThrow(/cwd outside allowlist/);
    expect(() => provider.createSession({ cwd: ".", shell: "/bin/fish" })).toThrow(/shell outside allowlist/);
  });

  it("enforces session cap", () => {
    const provider = createProvider({ create: () => new MockPty() });
    provider.createSession({ cwd: ".", shell: "/bin/bash" });
    provider.createSession({ cwd: ".", shell: "/bin/bash" });
    expect(() => provider.createSession({ cwd: ".", shell: "/bin/bash" })).toThrow(/session cap/);
  });

  it("disposes on idle timeout", () => {
    vi.useFakeTimers();
    const pty = new MockPty();
    const provider = createProvider({ create: () => pty });
    const exits: unknown[] = [];
    provider.on("session:exit", (event) => exits.push(event));

    provider.createSession({ cwd: ".", shell: "/bin/bash" });
    vi.advanceTimersByTime(1000);

    expect(pty.kills).toEqual(["SIGTERM"]);
    expect(exits).toEqual([{ sessionId: "pty-1", exitCode: null, signal: null, reason: "idle-timeout" }]);
    expect(provider.getSessionCount()).toBe(0);
  });

  it("disposes explicitly and stops future writes", () => {
    const pty = new MockPty();
    const provider = createProvider({ create: () => pty });
    const session = provider.createSession({ cwd: ".", shell: "/bin/bash" });

    session.dispose();
    expect(pty.kills).toEqual(["SIGTERM"]);
    expect(provider.getSessionCount()).toBe(0);
    expect(() => provider.write(session.id, "x")).toThrow(/unknown session/);
  });

  it("disposes on provider shutdown", () => {
    const pty = new MockPty();
    const provider = createProvider({ create: () => pty });
    provider.createSession({ cwd: ".", shell: "/bin/bash" });

    provider.dispose();
    expect(pty.kills).toEqual(["SIGTERM"]);
    expect(provider.getSessionCount()).toBe(0);
  });

  it("rejects when provider disabled", () => {
    const policy = parseShellProviderPolicy({
      GITBOARD_SHELL_PROVIDER_ENABLED: "0",
    } as NodeJS.ProcessEnv);
    const status = getShellProviderStatus({ NODE_ENV: "development", HOST: "localhost" } as NodeJS.ProcessEnv);
    const provider = new LocalPtyProvider({ policy, status, workspaceRoot: "/repo", ptyFactory: { create: () => new MockPty() } });

    expect(() => provider.createSession({ cwd: ".", shell: "/bin/bash" })).toThrow(/shell provider disabled/);
  });
});
