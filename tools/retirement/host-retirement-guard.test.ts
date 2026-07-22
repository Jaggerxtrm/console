/**
 * Phase 0 guard validation: proves the host-retirement guard fails against
 * the current production state and passes against the intended console-host
 * fixture. Run with: bun test tools/retirement/host-retirement-guard.test.ts
 */
import { describe, expect, test } from "bun:test";
import { evaluate, scanTree, DEPRECATED_HOST_PATH } from "./host-retirement-guard";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const FIXTURE_ROOT = join(import.meta.dir, "fixtures", "console-host");

describe("host-retirement-guard", () => {
  test("strict mode FAILS against current repo (ExecStart references apps/gitboard)", () => {
    const report = evaluate({ mode: "strict", root: REPO_ROOT });
    expect(report.pass).toBe(false);
    expect(report.verdict).toBe("FAIL");
    expect(report.findings.length).toBeGreaterThan(0);

    const categories = new Set(report.findings.map((f) => f.category));
    expect(categories.has("container")).toBe(true);
    expect(categories.has("service-definition")).toBe(true);
    expect(categories.has("build-script")).toBe(true);
  });

  test("console-host mode PASSES against intended fixture", () => {
    const report = evaluate({ mode: "console-host", root: REPO_ROOT, fixtureRoot: FIXTURE_ROOT });
    expect(report.pass).toBe(true);
    expect(report.verdict).toBe("PASS");
    expect(report.findings.length).toBe(0);
    expect(report.scannedFiles).toBeGreaterThan(0);
  });

  test("no-new-regressions mode PASSES when baseline matches current state", () => {
    const report = evaluate({
      mode: "no-new-regressions",
      root: REPO_ROOT,
      baselinePath: join(import.meta.dir, "baseline.json"),
    });
    expect(report.pass).toBe(true);
    expect(report.verdict).toBe("PASS");
    expect(report.newRegressions.length).toBe(0);
  });

  test("fixture host.ts string literal does NOT trip production-import scanner", () => {
    const { findings } = scanTree(FIXTURE_ROOT);
    const importFindings = findings.filter((f) => f.category === "production-import");
    expect(importFindings.length).toBe(0);
  });

  test("strict mode detects all known production surfaces", () => {
    const report = evaluate({ mode: "strict", root: REPO_ROOT });
    const files = report.findings.map((f) => f.file);
    expect(files).toContain("Dockerfile");
    expect(files).toContain("docs/deployment.md");
    expect(files).toContain("justfile");
  });

  test("DEPRECATED_HOST_PATH is apps/gitboard", () => {
    expect(DEPRECATED_HOST_PATH).toBe("apps/gitboard");
  });
});
