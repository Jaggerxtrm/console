import { describe, expect, it } from "vitest";
import { isInsidePath, safeJoin } from "./security.ts";

describe("security path helpers", () => {
  it("allows paths inside the configured root", () => {
    expect(isInsidePath("/tmp/root", "/tmp/root/docs/index.html")).toBe(true);
    expect(safeJoin("/tmp/root", "docs/index.html")).toBe("/tmp/root/docs/index.html");
  });

  it("rejects traversal outside the configured root", () => {
    expect(isInsidePath("/tmp/root", "/tmp/root/../secret.html")).toBe(false);
    expect(safeJoin("/tmp/root", "../secret.html")).toBeNull();
  });
});
