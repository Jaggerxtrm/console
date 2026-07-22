/**
 * Phase 0 guard validation: proves the host-retirement guard fails against
 * the current production state and passes against the intended console-host
 * fixture. Run with: bun test tools/retirement/host-retirement-guard.test.ts
 */
import { describe, expect, test } from "bun:test";
import { evaluate, scanTree, DEPRECATED_HOST_PATH, GUARD_MAX_FILE_BYTES } from "./host-retirement-guard";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

  test("no-new-regressions mode FAILS against a synthetic new production reference", () => {
    const root = mkdtempSync(join(tmpdir(), "console-host-retirement-negative-"));
    const baselinePath = join(root, "baseline.json");
    try {
      writeFileSync(join(root, "Dockerfile"), 'CMD ["bun", "apps/gitboard/src/index.ts"]\\n');
      writeFileSync(baselinePath, JSON.stringify({ deprecatedHost: DEPRECATED_HOST_PATH, fingerprints: [] }));

      const report = evaluate({ mode: "no-new-regressions", root, baselinePath });
      expect(report.pass).toBe(false);
      expect(report.verdict).toBe("FAIL");
      expect(report.newRegressions).toHaveLength(1);
      expect(report.newRegressions[0]).toMatchObject({ category: "container", file: "Dockerfile" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fixture host.ts string literal does NOT trip production-import scanner", () => {
    const { findings } = scanTree(FIXTURE_ROOT);
    const importFindings = findings.filter((f) => f.category === "production-import");
    expect(importFindings.length).toBe(0);
  });

  test("classifies every production guard category", () => {
    const root = mkdtempSync(join(tmpdir(), "console-host-retirement-categories-"));
    try {
      mkdirSync(join(root, "apps", "console", "src"), { recursive: true });
      mkdirSync(join(root, "systemd"), { recursive: true });
      writeFileSync(join(root, "Dockerfile"), 'CMD ["bun", "apps/gitboard/src/index.ts"]\n');
      writeFileSync(join(root, "justfile"), "serve: bun run apps/gitboard/src/index.ts\n");
      writeFileSync(join(root, "systemd", "console.service"), "ExecStart=/usr/bin/bun apps/gitboard/src/index.ts\n");
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { serve: "bun run apps/gitboard/src/index.ts" } }));
      writeFileSync(join(root, "apps", "console", "src", "index.ts"), 'import legacy from "apps/gitboard/src/index.ts";\n');

      const { findings } = scanTree(root);
      expect(new Set(findings.map((finding) => finding.category))).toEqual(new Set([
        "container",
        "build-script",
        "service-definition",
        "workspace-manifest",
        "production-import",
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  test("fails closed on a symlinked directory pointing outside the root", () => {
    const root = mkdtempSync(join(tmpdir(), "console-host-retirement-symdir-"));
    const outside = mkdtempSync(join(tmpdir(), "console-host-retirement-outside-"));
    try {
      mkdirSync(join(outside, "apps", "gitboard", "src"), { recursive: true });
      writeFileSync(join(outside, "apps", "gitboard", "src", "index.ts"), "export const legacy = true;\n");
      symlinkSync(outside, join(root, "linked"));

      const { findings } = scanTree(root);
      const unsafe = findings.filter((f) => f.category === "unsafe-fs-entry");
      expect(unsafe).toHaveLength(1);
      expect(unsafe[0]).toMatchObject({ category: "unsafe-fs-entry", file: "linked" });
      // The link is never followed, so the outside import is NOT scanned in.
      expect(findings.filter((f) => f.category === "production-import")).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("fails closed on a self-referential symlink cycle without hanging", () => {
    const root = mkdtempSync(join(tmpdir(), "console-host-retirement-cycle-"));
    try {
      mkdirSync(join(root, "dir"), { recursive: true });
      symlinkSync(join(root, "dir"), join(root, "dir", "loop"));

      const { findings } = scanTree(root);
      const unsafe = findings.filter((f) => f.category === "unsafe-fs-entry");
      expect(unsafe).toHaveLength(1);
      expect(unsafe[0]).toMatchObject({ file: join("dir", "loop") });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed on a leaf symlink file instead of reading its target", () => {
    const root = mkdtempSync(join(tmpdir(), "console-host-retirement-symfile-"));
    const outside = mkdtempSync(join(tmpdir(), "console-host-retirement-symfile-out-"));
    try {
      const target = join(outside, "Dockerfile");
      writeFileSync(target, 'CMD ["bun", "apps/gitboard/src/index.ts"]\n');
      symlinkSync(target, join(root, "Dockerfile"));

      const { findings } = scanTree(root);
      const unsafe = findings.filter((f) => f.category === "unsafe-fs-entry");
      expect(unsafe).toHaveLength(1);
      expect(unsafe[0]).toMatchObject({ file: "Dockerfile" });
      expect(findings.filter((f) => f.category === "container")).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("fails closed with exact path/category on an oversized classified source", () => {
    const root = mkdtempSync(join(tmpdir(), "console-host-retirement-oversized-"));
    try {
      mkdirSync(join(root, "apps", "console", "src"), { recursive: true });
      const big = join(root, "apps", "console", "src", "big.ts");
      writeFileSync(big, Buffer.alloc(GUARD_MAX_FILE_BYTES + 1, 97));

      const { findings } = scanTree(root);
      const unsafe = findings.filter((f) => f.category === "unsafe-fs-entry");
      expect(unsafe).toHaveLength(1);
      expect(unsafe[0]).toMatchObject({
        category: "unsafe-fs-entry",
        file: join("apps", "console", "src", "big.ts"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed on an unreadable classified file (chmod 000) with an exact-path unsafe finding", () => {
    const root = mkdtempSync(join(tmpdir(), "console-host-retirement-unreadable-"));
    const secretRel = join("apps", "console", "src", "secret.ts");
    try {
      mkdirSync(join(root, "apps", "console", "src"), { recursive: true });
      const secret = join(root, secretRel);
      writeFileSync(secret, 'import legacy from "apps/gitboard/src/index.ts";\n');
      chmodSync(secret, 0o000);

      const { findings } = scanTree(root);
      // The unreadable classified file fails closed: no production-import
      // finding (content never read) but an exact-path unsafe-fs-entry finding.
      expect(findings.filter((f) => f.category === "production-import")).toHaveLength(0);
      const unsafe = findings.filter((f) => f.category === "unsafe-fs-entry");
      expect(unsafe).toHaveLength(1);
      expect(unsafe[0]).toMatchObject({ category: "unsafe-fs-entry", file: secretRel, line: 1 });

      // strict mode FAILS on the unsafe finding.
      const strict = evaluate({ mode: "strict", root });
      expect(strict.pass).toBe(false);
      expect(strict.verdict).toBe("FAIL");
      expect(strict.findings.some((f) => f.category === "unsafe-fs-entry" && f.file === secretRel)).toBe(true);

      // no-new-regressions FAILS with an empty baseline (unsafe finding is new).
      const baselinePath = join(root, "baseline.json");
      writeFileSync(baselinePath, JSON.stringify({ deprecatedHost: DEPRECATED_HOST_PATH, fingerprints: [] }));
      const noNew = evaluate({ mode: "no-new-regressions", root, baselinePath });
      expect(noNew.pass).toBe(false);
      expect(noNew.verdict).toBe("FAIL");
      expect(noNew.newRegressions.some((f) => f.category === "unsafe-fs-entry" && f.file === secretRel)).toBe(true);
    } finally {
      // Restore permissions so rmSync can clean up.
      chmodSync(join(root, secretRel), 0o644);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed on an unreadable directory (chmod 000) with an exact-path unsafe finding", () => {
    const root = mkdtempSync(join(tmpdir(), "console-host-retirement-unreadable-dir-"));
    try {
      const locked = join(root, "locked");
      mkdirSync(locked, { recursive: true });
      writeFileSync(join(locked, "Dockerfile"), 'CMD ["bun", "apps/gitboard/src/index.ts"]\n');
      chmodSync(locked, 0o000);

      const { findings } = scanTree(root);
      // The unreadable directory fails closed: no container finding (entries
      // never listed) but an exact-path unsafe-fs-entry finding for the dir.
      expect(findings.filter((f) => f.category === "container")).toHaveLength(0);
      const unsafe = findings.filter((f) => f.category === "unsafe-fs-entry");
      expect(unsafe).toHaveLength(1);
      expect(unsafe[0]).toMatchObject({ category: "unsafe-fs-entry", file: "locked", line: 1 });

      // strict mode FAILS on the unsafe finding.
      const strict = evaluate({ mode: "strict", root });
      expect(strict.pass).toBe(false);
      expect(strict.verdict).toBe("FAIL");
      expect(strict.findings.some((f) => f.category === "unsafe-fs-entry" && f.file === "locked")).toBe(true);

      // no-new-regressions FAILS with an empty baseline (unsafe finding is new).
      const baselinePath = join(root, "baseline.json");
      writeFileSync(baselinePath, JSON.stringify({ deprecatedHost: DEPRECATED_HOST_PATH, fingerprints: [] }));
      const noNew = evaluate({ mode: "no-new-regressions", root, baselinePath });
      expect(noNew.pass).toBe(false);
      expect(noNew.verdict).toBe("FAIL");
      expect(noNew.newRegressions.some((f) => f.category === "unsafe-fs-entry" && f.file === "locked")).toBe(true);
    } finally {
      chmodSync(join(root, "locked"), 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("strict mode FAILS when a symlink or oversized candidate is present", () => {
    const root = mkdtempSync(join(tmpdir(), "console-host-retirement-strict-unsafe-"));
    const outside = mkdtempSync(join(tmpdir(), "console-host-retirement-strict-out-"));
    try {
      symlinkSync(outside, join(root, "linked"));
      const report = evaluate({ mode: "strict", root });
      expect(report.pass).toBe(false);
      expect(report.verdict).toBe("FAIL");
      expect(report.findings.some((f) => f.category === "unsafe-fs-entry")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
