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
  });

  it("persists drawer state and rehydrates", async () => {
    const { useShellStore } = await import("../../../src/dashboard/stores/shell.ts");
    useShellStore.getState().setDrawerOpen(true);
    useShellStore.getState().setDrawerHeight(333);
    useShellStore.getState().setDrawerTab("specialists");

    vi.resetModules();
    const { useShellStore: rehydrated } = await import("../../../src/dashboard/stores/shell.ts");
    expect(rehydrated.getState().drawerOpen).toBe(true);
    expect(rehydrated.getState().drawerHeight).toBe(333);
    expect(rehydrated.getState().drawerTab).toBe("specialists");
  });

  it("clamps drawer height", async () => {
    const { useShellStore } = await import("../../../src/dashboard/stores/shell.ts");
    useShellStore.getState().setDrawerHeight(10);
    expect(useShellStore.getState().drawerHeight).toBe(120);
    useShellStore.getState().setDrawerHeight(999);
    expect(useShellStore.getState().drawerHeight).toBe(600);
  });
});
