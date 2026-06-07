import { describe, expect, it } from "vitest";
import { createRuntimeHostDescriptor, runtimeHostHasCapability } from "../src/runtime/index.ts";

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
  });
});
