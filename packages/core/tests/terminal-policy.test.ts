import { describe, expect, it, vi } from "vitest";
import {
  getProviderPermission,
  getShellProviderStatus,
  isAllowedShellWebSocketOrigin,
  isShellCapableProviderKind,
  isVerifiedShellAdminRequest,
  parseShellProviderPolicy,
  shellProviderDisabledMessage,
  shouldRejectShellWebSocket,
} from "../src/terminal/policy.ts";

describe("terminal shell policy", () => {
  it("defaults disabled in production-like context", () => {
    const status = getShellProviderStatus({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
    expect(status.enabled).toBe(false);
    expect(status.disabledReason).toContain("disabled");
  });

  it("denies enabled env when admin-only true and no verified admin", () => {
    const env = {
      NODE_ENV: "production",
      HOST: "localhost",
      GITBOARD_SHELL_PROVIDER_ENABLED: "1",
      GITBOARD_SHELL_PROVIDER_ALLOW_REMOTE: "1",
      GITBOARD_SHELL_PROVIDER_DEV_GATE: "0",
      GITBOARD_SHELL_PROVIDER_ADMIN_ONLY: "1",
    } as NodeJS.ProcessEnv;
    const status = getShellProviderStatus(env);
    expect(status.enabled).toBe(false);
    expect(status.disabledReason).toContain("admin-only");
    expect(shellProviderDisabledMessage(status)).toContain("verified admin");
  });

  it("enables only with explicit env gate, remote allowlist, and verified admin", () => {
    const env = {
      NODE_ENV: "production",
      HOST: "localhost",
      GITBOARD_SHELL_PROVIDER_ENABLED: "1",
      GITBOARD_SHELL_PROVIDER_ALLOW_REMOTE: "1",
      GITBOARD_SHELL_PROVIDER_DEV_GATE: "0",
      GITBOARD_SHELL_PROVIDER_ADMIN_ONLY: "1",
    } as NodeJS.ProcessEnv;
    const status = getShellProviderStatus(env, { isVerifiedAdmin: true });
    expect(status.enabled).toBe(true);
    expect(status.policy.enabled).toBe(true);
    expect(shellProviderDisabledMessage(status)).toContain("cwd allowlist");
  });

  it("separates specialist-feed readonly permission from shell-capable providers", () => {
    expect(isShellCapableProviderKind("specialist-feed")).toBe(false);
    expect(getProviderPermission("specialist-feed")).toBe("readonly");
    expect(isShellCapableProviderKind("pty")).toBe(true);
    expect(getProviderPermission("pty")).toBe("shell");
    expect(getProviderPermission("ssh")).toBe("shell");
  });

  it("parses allowlists and caps", () => {
    const policy = parseShellProviderPolicy({
      GITBOARD_SHELL_PROVIDER_CWD_ALLOWLIST: "/repo,/worktree",
      GITBOARD_SHELL_PROVIDER_SHELL_ALLOWLIST: "/bin/zsh",
      GITBOARD_SHELL_PROVIDER_ENV_SCRUB: "HOME,PATH,SECRET",
      GITBOARD_SHELL_PROVIDER_MAX_SESSIONS: "3",
      GITBOARD_SHELL_PROVIDER_IDLE_TIMEOUT_MS: "1000",
      GITBOARD_SHELL_PROVIDER_HARD_TTL_MS: "2000",
    } as NodeJS.ProcessEnv);
    expect(policy.cwdAllowlist).toEqual(["/repo", "/worktree"]);
    expect(policy.shellAllowlist).toEqual(["/bin/zsh"]);
    expect(policy.envScrub).toEqual(["HOME", "PATH", "SECRET"]);
    expect(policy.maxSessions).toBe(3);
    expect(policy.idleTimeoutMs).toBe(1000);
    expect(policy.hardTtlMs).toBe(2000);
  });

  it("keeps user shell, HOME, and PATH available by default", () => {
    const policy = parseShellProviderPolicy({ SHELL: "/bin/zsh" } as NodeJS.ProcessEnv);

    expect(policy.shellAllowlist).toContain("/bin/zsh");
    expect(policy.envScrub).not.toContain("HOME");
    expect(policy.envScrub).not.toContain("PATH");
    expect(policy.envScrub).toContain("GITHUB_TOKEN");
  });

  it("validates local websocket origins and admin request tokens", () => {
    expect(isAllowedShellWebSocketOrigin("http://127.0.0.1:5173", "localhost:5173")).toBe(true);
    expect(isAllowedShellWebSocketOrigin("https://evil.example", "localhost:5173")).toBe(false);
    expect(isVerifiedShellAdminRequest(new Headers({ "x-gitboard-shell-token": "secret" }), { GITBOARD_SHELL_PROVIDER_ADMIN_TOKEN: "secret" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isVerifiedShellAdminRequest(new Headers(), { GITBOARD_SHELL_PROVIDER_ADMIN_TOKEN: "secret" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("rejects malformed origins without writing attacker-controlled text", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const malformed = "not-a-url-terminal-secret";

    expect(isAllowedShellWebSocketOrigin(malformed, "localhost:3030")).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("refuses shell websocket paths when policy status is disabled", () => {
    const status = getShellProviderStatus({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
    expect(shouldRejectShellWebSocket("/api/console/shell/ws", status)).toBe(true);
    expect(shouldRejectShellWebSocket("/api/console/terminal/ws", status)).toBe(true);
    expect(shouldRejectShellWebSocket("/api/feed", status)).toBe(false);
    expect(shouldRejectShellWebSocket("/api/console/shell/status", status)).toBe(false);
    expect(shouldRejectShellWebSocket("/api/console/shell-evil", status)).toBe(false);
    expect(shouldRejectShellWebSocket("/api/console/terminal/ws-evil", status)).toBe(false);
  });
});
