import { describe, expect, it } from "vitest";
import { COALESCE_MS as appCoalesceMs, Materializer as AppMaterializer } from "../../src/core/materializer/index.ts";
import { createXtrmDatabase as createAppXtrmDatabase } from "../../src/core/xtrm-store.ts";
import { COALESCE_MS as coreCoalesceMs, Materializer as CoreMaterializer } from "../../../../packages/core/src/materializer/index.ts";
import { createXtrmDatabase as createCoreXtrmDatabase } from "../../../../packages/core/src/state/database.ts";

describe("runtime compatibility wrappers", () => {
  it("keeps the app schema initializer as a pure core re-export", () => {
    expect(createAppXtrmDatabase).toBe(createCoreXtrmDatabase);
  });

  it("keeps the app materializer wrapper backed by the core implementation", () => {
    const materializer = new AppMaterializer({} as never);

    expect(materializer).toBeInstanceOf(CoreMaterializer);
    expect(() => materializer.trigger("missing:source")).toThrow("unknown source: missing:source");
    expect(appCoalesceMs).toBe(coreCoalesceMs);
  });
});
