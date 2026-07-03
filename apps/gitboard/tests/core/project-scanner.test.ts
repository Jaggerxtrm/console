import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectScanner } from "../../src/core/project-scanner.ts";

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
});
