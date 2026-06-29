import { describe, expect, expectTypeOf, it } from "vitest";
import type { Datasource, ExploreMountResult, ExplorePanelKind } from "../src/index.ts";

function renderKind(kind: ExplorePanelKind): string {
  switch (kind) {
    case "agentops":
      return "AgentOps";
    case "forensic":
      return "Forensic";
    case "prom":
      return "Prometheus";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

describe("explore datasource types", () => {
  it("keeps panel kind exhaustiveness compile-enforced", () => {
    expect(renderKind("agentops")).toBe("AgentOps");
    expect(renderKind("forensic")).toBe("Forensic");
    expect(renderKind("prom")).toBe("Prometheus");
  });

  it("keeps primary explore mounts native", () => {
    const agentopsNative: Datasource = {
      id: "agentops",
      kind: "agentops",
      label: "AgentOps",
      mount: () => ({
        id: "agentops",
        kind: "agentops",
        title: "AgentOps",
        mount: "native",
        component: "agentops-explorer",
      }),
    };

    const forensicNative: Datasource = {
      id: "forensic-events",
      kind: "forensic",
      label: "Forensic events",
      mount: () => ({
        id: "forensic",
        kind: "forensic",
        title: "Forensic",
        mount: "native",
        component: "coming-soon",
      }),
    };

    const agentopsMount = agentopsNative.mount();
    const forensicMount = forensicNative.mount();

    expect(agentopsMount.mount).toBe("native");
    expect(forensicMount.mount).toBe("native");
    expectTypeOf(agentopsMount).toMatchTypeOf<ExploreMountResult>();
    expectTypeOf(forensicMount).toMatchTypeOf<ExploreMountResult>();
  });

  it("exports public types from the package barrel", () => {
    expectTypeOf<Datasource>().toHaveProperty("kind").toEqualTypeOf<ExplorePanelKind>();
    expectTypeOf<ExploreMountResult>().toMatchTypeOf<
      { kind: "agentops" | "forensic" | "prom"; mount: "native" }
    >();
  });
});
