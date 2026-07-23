import { describe, expect, it } from "vitest";
import { createRuntimeHostDescriptor, createRuntimeLifecycle, createRuntimeLifecyclePlan, runtimeHostHasCapability } from "../src/runtime/index.ts";

describe("runtime host descriptor", () => {
  it("captures host capabilities without owning app implementations", () => {
    const host = createRuntimeHostDescriptor({
      owner: "apps/console",
      storeDb: "store",
      stateDb: "state",
      registry: "registry",
      materializer: "materializer",
      mountedRoutes: ["/api/feed", "/api/substrate"],
      capabilities: ["http-api", "materializer", "internal-logs"],
    });

    expect(host).toMatchObject({
      owner: "apps/console",
      storeDb: "store",
      stateDb: "state",
      registry: "registry",
      materializer: "materializer",
    });
    expect(runtimeHostHasCapability(host, "materializer")).toBe(true);
    expect(runtimeHostHasCapability(host, "github-adapter")).toBe(false);
    expect(host.mountedRoutes).toEqual(["/api/feed", "/api/substrate"]);
    expect(host.staticServiceParity).toEqual([]);
  });

  it("proves Console ownership through the canonical host-neutral factories", () => {
    const plan = createRuntimeLifecyclePlan({ owner: "apps/console", hasStateDatabase: false });
    const lifecycle = createRuntimeLifecycle(plan, {
      storeDb: "store",
      stateDb: null,
      registry: "registry",
      createMaterializer: () => ({ created: "materializer" }),
      createScanner: () => ({ created: "scanner" }),
      createBeadsWatcher: () => ({ created: "beads-watcher" }),
      createObservabilityWatcher: () => ({ created: "observability-watcher" }),
      createBeadsParityHarness: (db, options) => ({ db, options }),
      createObservabilityParityHarness: (db, options) => ({ db, options }),
    });

    expect(plan.owner).toBe("apps/console");
    expect(lifecycle.runtimeHost.owner).toBe("apps/console");
  });

  it("creates the complete Console lifecycle when durable state is available", () => {
    const plan = createRuntimeLifecyclePlan({
      owner: "apps/console",
      hasStateDatabase: true,
      isDatasetteDebugEnabled: true,
      isParityEnabled: true,
    });
    const lifecycle = createRuntimeLifecycle(plan, {
      storeDb: "store",
      stateDb: "state",
      registry: "registry",
      createMaterializer: (db, registry) => ({ db, registry }),
      createScanner: (db, options) => ({ db, options }),
      createBeadsWatcher: (materializer, db, registry) => ({ materializer, db, registry }),
      createObservabilityWatcher: () => ({ watcher: "observability" }),
      createBeadsParityHarness: (db, options) => ({ db, options, harness: "beads" }),
      createObservabilityParityHarness: (db, options) => ({ db, options, harness: "observability" }),
    });

    expect(plan.owner).toBe("apps/console");
    expect(lifecycle.runtimeHost.owner).toBe("apps/console");
    expect(plan.mountedRoutes).toContain("/explore/sql");
    expect(lifecycle.materializer).toEqual({ db: "store", registry: "registry" });
    expect(lifecycle.scanner).toEqual({ db: "store", options: { parityEnabled: true } });
    expect(lifecycle.beadsWatcher).toMatchObject({ db: "state", registry: "registry" });
    expect(lifecycle.runtimeHost.mountedRoutes).toContain("/api/sources");
    expect(lifecycle.runtimeHost.capabilities).toContain("source-health");
    expect(lifecycle.runtimeHost.staticServiceParity).toEqual([
      expect.objectContaining({ route: "/console", state: "retired", blockers: [] }),
      expect.objectContaining({ route: "/gitboard", state: "retired", blockers: [] }),
      expect.objectContaining({ route: "/health", state: "retired", blockers: [] }),
      expect.objectContaining({ route: "runtime-descriptor", state: "retired", blockers: [] }),
    ]);
  });

  it("keeps degraded readable mode when state database is absent", () => {
    const plan = createRuntimeLifecyclePlan({ owner: "apps/console", hasStateDatabase: false });
    const lifecycle = createRuntimeLifecycle(plan, {
      storeDb: "store",
      stateDb: null,
      registry: "registry",
      createMaterializer: () => ({ created: "materializer" }),
      createScanner: () => ({ created: "scanner" }),
      createBeadsWatcher: () => ({ created: "beads-watcher" }),
      createObservabilityWatcher: () => ({ created: "observability-watcher" }),
      createBeadsParityHarness: (db, options) => ({ db, options }),
      createObservabilityParityHarness: (db, options) => ({ db, options }),
    });

    expect(lifecycle.materializer).toBeNull();
    expect(lifecycle.scanner).toBeNull();
    expect(lifecycle.beadsWatcher).toBeNull();
    expect(lifecycle.runtimeHost.stateDb).toBeNull();
    expect(lifecycle.runtimeHost.mountedRoutes).toContain("/api/feed");
  });
});
