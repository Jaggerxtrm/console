import { describe, expect, it } from "vitest";
import { createGitboardRuntimeLifecycle, createGitboardRuntimeLifecyclePlan, createRuntimeHostDescriptor, runtimeHostHasCapability } from "../src/runtime/index.ts";

describe("runtime host descriptor", () => {
  it("captures compatibility host capabilities without owning app implementations", () => {
    const host = createRuntimeHostDescriptor({
      storeDb: "store",
      stateDb: "state",
      registry: "registry",
      materializer: "materializer",
      mountedRoutes: ["/api/feed", "/api/substrate"],
      capabilities: ["http-api", "materializer", "internal-logs"],
    });

    expect(host).toMatchObject({
      compatibilityHost: "apps/gitboard",
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

  it("owns gitboard lifecycle policy while app supplies concrete adapters", () => {
    const plan = createGitboardRuntimeLifecyclePlan({
      hasStateDatabase: true,
      isDatasetteDebugEnabled: true,
      isParityEnabled: true,
    });
    const lifecycle = createGitboardRuntimeLifecycle(plan, {
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

    expect(plan.mountedRoutes).toContain("/explore/sql");
    expect(lifecycle.materializer).toEqual({ db: "store", registry: "registry" });
    expect(lifecycle.scanner).toEqual({ db: "store", options: { parityEnabled: true } });
    expect(lifecycle.beadsWatcher).toMatchObject({ db: "state", registry: "registry" });
    expect(lifecycle.runtimeHost.mountedRoutes).toContain("/api/sources");
    expect(lifecycle.runtimeHost.capabilities).toContain("source-health");
    expect(lifecycle.runtimeHost.staticServiceParity).toEqual([
      expect.objectContaining({ route: "/console", state: "retained" }),
      expect.objectContaining({ route: "/gitboard", state: "retained" }),
      expect.objectContaining({ route: "/health", state: "retained" }),
      expect.objectContaining({ route: "runtime-descriptor", state: "retained" }),
    ]);
  });

  it("keeps degraded readable mode when state database is absent", () => {
    const plan = createGitboardRuntimeLifecyclePlan({ hasStateDatabase: false });
    const lifecycle = createGitboardRuntimeLifecycle(plan, {
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
