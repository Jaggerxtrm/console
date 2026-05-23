import { beforeEach, describe, expect, it, vi } from "vitest";

function makeStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    clear: () => { data.clear(); },
  };
}

describe("shell store drawer persistence", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("localStorage", makeStorage());
    vi.stubGlobal("window", { innerHeight: 800 } as typeof window);
  });

  it("persists drawer state and rehydrates", async () => {
    const { useShellStore } = await import("../../../src/dashboard/stores/shell.ts");
    useShellStore.getState().setDrawerOpen(true);
    useShellStore.getState().setDrawerHeight(333);
    useShellStore.getState().setDrawerTab("terminal");
    useShellStore.getState().setTerminalSessionId("session-1");
    useShellStore.getState().appendTerminalOutput("hello\n");

    vi.resetModules();
    const { useShellStore: rehydrated } = await import("../../../src/dashboard/stores/shell.ts");
    expect(rehydrated.getState().drawerOpen).toBe(true);
    expect(rehydrated.getState().drawerHeight).toBe(333);
    expect(rehydrated.getState().drawerTab).toBe("terminal");
    expect(rehydrated.getState().terminalSessionId).toBe(null);
    expect(rehydrated.getState().terminalOutput).toEqual([]);
  });

  it("clamps drawer height", async () => {
    const { useShellStore } = await import("../../../src/dashboard/stores/shell.ts");
    useShellStore.getState().setDrawerHeight(10);
    expect(useShellStore.getState().drawerHeight).toBe(120);
    useShellStore.getState().setDrawerHeight(999);
    expect(useShellStore.getState().drawerHeight).toBe(776);
  });

  it("defaults drawer height to 75vh on fresh load", async () => {
    const { useShellStore } = await import("../../../src/dashboard/stores/shell.ts");
    expect(useShellStore.getState().drawerHeight).toBe(600);
  });

  it("switches to a repo that supports the target surface", async () => {
    const { useShellStore } = await import("../../../src/dashboard/stores/shell.ts");
    useShellStore.setState({
      repos: [
        { fullName: "owner/no-beads", displayName: "no-beads", lastActivityAt: null, openBeadsCount: 0, githubStats: { openPRs: 0, commitsToday: 0, openIssues: 0, releases: 0 }, beadsStats: { open: 0, inProgress: 0, blocked: 0, epics: 0 }, beadsSource: null, hasGithub: true, hasBeads: false },
        { fullName: "owner/with-beads", displayName: "with-beads", lastActivityAt: null, openBeadsCount: 1, githubStats: { openPRs: 0, commitsToday: 0, openIssues: 0, releases: 0 }, beadsStats: { open: 1, inProgress: 0, blocked: 0, epics: 0 }, beadsSource: null, hasGithub: true, hasBeads: true },
      ],
      selection: { surface: "github", tab: "activity", repo: "owner/no-beads" },
    });

    useShellStore.getState().setSurface("console");

    expect(useShellStore.getState().selection).toEqual({ surface: "console", tab: "feed", repo: "owner/with-beads" });
  });

});
