import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChannelRegistry } from "../../src/api/ws/channels.ts";
import { createXtrmDatabase } from "../../src/core/xtrm-store.ts";
import { ProjectScanner } from "../../src/core/project-scanner.ts";
import type { Materializer } from "../../src/core/materializer/index.ts";
import { TriggerWatcher } from "../../src/server/beads/trigger-watcher.ts";

describe("ProjectScanner", () => {
  let tmpDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gitboard-project-scanner-"));
    repoDir = join(tmpDir, "demo-repo");
    await mkdir(join(repoDir, ".beads"), { recursive: true });
    await writeFile(join(repoDir, ".beads", "metadata.json"), JSON.stringify({ project_id: "demo-project" }));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("skips hidden operational directories while preserving root beads discovery", async () => {
    await mkdir(join(repoDir, ".specialists", "jobs", "job-a", ".beads"), { recursive: true });
    await mkdir(join(repoDir, ".xtrm", "nested", ".beads"), { recursive: true });
    await writeFile(join(repoDir, ".specialists", "jobs", "job-a", ".beads", "metadata.json"), JSON.stringify({ project_id: "job-project" }));
    await writeFile(join(repoDir, ".xtrm", "nested", ".beads", "metadata.json"), JSON.stringify({ project_id: "xtrm-nested-project" }));
    const scanner = new ProjectScanner({ scanPaths: [tmpDir], excludePatterns: ["node_modules", ".git"], maxDepth: 5 });

    const projects = await scanner.scanAll();

    expect(projects.map((project) => project.id).sort()).toEqual(["demo-project"]);
  });

  it("shares one in-flight traversal across concurrent callers", async () => {
    const scanner = new ProjectScanner({ scanPaths: [tmpDir], excludePatterns: ["node_modules", ".git"], maxDepth: 5 });
    const scannerWithPrivateMethods = scanner as unknown as {
      scanPath: (path: string, depth: number) => Promise<unknown[]>;
    };
    const originalScanPath = scannerWithPrivateMethods.scanPath;
    let rootTraversals = 0;
    let releaseRoot!: () => void;
    let rootStarted!: () => void;
    const rootReady = new Promise<void>((resolve) => { rootStarted = resolve; });
    const rootRelease = new Promise<void>((resolve) => { releaseRoot = resolve; });
    scannerWithPrivateMethods.scanPath = async (path, depth) => {
      if (depth === 0) {
        rootTraversals += 1;
        rootStarted();
        await rootRelease;
      }
      return originalScanPath.call(scanner, path, depth);
    };

    const first = scanner.scanAll();
    await rootReady;
    const second = scanner.scanAll();
    releaseRoot();
    const [firstProjects, secondProjects] = await Promise.all([first, second]);

    expect(rootTraversals).toBe(1);
    expect(secondProjects).toEqual(firstProjects);
  });

  it("shares TriggerWatcher registration and runtime startup traversal", async () => {
    const db = createXtrmDatabase(join(tmpDir, "xtrm.sqlite"));
    const scanner = new ProjectScanner({ scanPaths: [tmpDir], excludePatterns: ["node_modules", ".git"], maxDepth: 5 });
    const scannerWithPrivateMethods = scanner as unknown as {
      scanAll: () => Promise<unknown[]>;
      scanPath: (path: string, depth: number) => Promise<unknown[]>;
    };
    const originalScanAll = scannerWithPrivateMethods.scanAll;
    const originalScanPath = scannerWithPrivateMethods.scanPath;
    let scanCallers = 0;
    let completedScans = 0;
    let rootTraversals = 0;
    let releaseTraversal!: () => void;
    let secondCaller!: () => void;
    const traversalRelease = new Promise<void>((resolve) => { releaseTraversal = resolve; });
    const secondCallerReady = new Promise<void>((resolve) => { secondCaller = resolve; });
    scannerWithPrivateMethods.scanAll = async () => {
      scanCallers += 1;
      if (scanCallers === 2) secondCaller();
      return originalScanAll.call(scanner);
    };
    scannerWithPrivateMethods.scanPath = async (path, depth) => {
      if (depth === 0) {
        rootTraversals += 1;
        await traversalRelease;
      }
      return originalScanPath.call(scanner, path, depth);
    };
    const materializer = { register: () => undefined, trigger: () => undefined } as unknown as Materializer;
    const watcher = new TriggerWatcher(materializer, db, new ChannelRegistry(), scanner);
    let allScansDone!: () => void;
    const scansDone = new Promise<void>((resolve) => { allScansDone = resolve; });
    scannerWithPrivateMethods.scanAll = async () => {
      scanCallers += 1;
      if (scanCallers === 2) secondCaller();
      const result = await originalScanAll.call(scanner);
      completedScans += 1;
      if (completedScans === 2) allScansDone();
      return result;
    };

    try {
      watcher.start();
      await secondCallerReady;
      releaseTraversal();
      await scansDone;
    } finally {
      watcher.stop();
      db.close();
    }

    expect(scanCallers).toBe(2);
    expect(rootTraversals).toBe(1);
  });

  it("clears in-flight traversal after resolve and reject", async () => {
    const scanner = new ProjectScanner({ scanPaths: [tmpDir], excludePatterns: ["node_modules", ".git"], maxDepth: 5 });
    const scannerWithPrivateMethods = scanner as unknown as {
      scanAll: () => Promise<unknown[]>;
      scanPath: (path: string, depth: number) => Promise<unknown[]>;
    };
    const originalScanPath = scannerWithPrivateMethods.scanPath;
    let rootTraversals = 0;
    scannerWithPrivateMethods.scanPath = async (path, depth) => {
      if (depth === 0) rootTraversals += 1;
      return originalScanPath.call(scanner, path, depth);
    };

    await scanner.scanAll();
    await scanner.scanAll();
    expect(rootTraversals).toBe(2);

    const rejectingScanner = new ProjectScanner({ scanPaths: [tmpDir], excludePatterns: ["node_modules", ".git"], maxDepth: 5 });
    const rejectingScannerWithPrivateMethods = rejectingScanner as unknown as {
      scanPath: (path: string, depth: number) => Promise<unknown[]>;
    };
    const rejectingOriginalScanPath = rejectingScannerWithPrivateMethods.scanPath;
    let reject = true;
    rejectingScannerWithPrivateMethods.scanPath = async (path, depth) => {
      if (reject) {
        reject = false;
        throw new Error("synthetic scan failure");
      }
      return rejectingOriginalScanPath.call(rejectingScanner, path, depth);
    };

    await expect(rejectingScanner.scanAll()).rejects.toThrow("synthetic scan failure");
    await expect(rejectingScanner.scanAll()).resolves.toHaveLength(1);
  });
});
