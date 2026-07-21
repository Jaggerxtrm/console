import { describe, expect, it } from "vitest";
import * as runtime from "../src/runtime/index.ts";

describe("runtime browser boundary", () => {
  it("does not expose server-only verifier through runtime barrel", () => {
    expect("Verifier" in runtime).toBe(false);
    expect("createVerifier" in runtime).toBe(false);
    expect("loadThresholds" in runtime).toBe(false);
    expect("summarize" in runtime).toBe(false);
  });
});
