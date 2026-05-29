import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { scanHtmlDocuments } from "./scanner.ts";

let tempRoot: string | null = null;

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

describe("scanHtmlDocuments", () => {

  it("excludes dependency, virtualenv, build, coverage, and agent state directories", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "doc-preview-"));
    const repo = join(tempRoot, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, "README.md"), "# Canonical\n");

    const excludedFiles = [
      join(repo, "node_modules", "pkg", "README.md"),
      join(repo, "venv", "lib", "README.md"),
      join(repo, ".venv", "lib", "README.md"),
      join(repo, "dist", "index.html"),
      join(repo, "build", "index.html"),
      join(repo, "coverage", "index.html"),
      join(repo, "htmlcov", "index.html"),
      join(repo, ".xtrm", "skills", "SKILL.md"),
      join(repo, ".claude", "skills", "SKILL.md"),
      join(repo, ".serena", "memories", "note.md"),
      join(repo, "ingestion", "articles", "generated.html"),
    ];

    for (const file of excludedFiles) {
      await mkdir(file.split("/").slice(0, -1).join("/"), { recursive: true });
      await writeFile(file, "# Excluded\n");
    }

    const index = await scanHtmlDocuments({
      root: tempRoot,
      roots: [tempRoot],
      maxDepth: 3,
      maxFiles: 50,
    });

    expect(index.documents.map((document) => document.path)).toEqual(["README.md"]);
  });

  it("excludes documents under .worktrees directories", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "doc-preview-"));
    const repo = join(tempRoot, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(repo, ".worktrees", "feature", ".git"), { recursive: true });
    await writeFile(join(repo, "README.md"), "# Canonical\n");
    await writeFile(join(repo, ".worktrees", "feature", "README.md"), "# Worktree Copy\n");

    const index = await scanHtmlDocuments({
      root: tempRoot,
      roots: [tempRoot],
      maxDepth: 3,
      maxFiles: 20,
    });

    expect(index.documents.map((document) => document.title)).toEqual(["Canonical"]);
  });

  it("does not let early repositories starve later repositories before applying the cap", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "doc-preview-"));
    const earlyRepo = join(tempRoot, "aaa-early");
    const laterRepo = join(tempRoot, "zzz-later");
    await mkdir(join(earlyRepo, ".git"), { recursive: true });
    await mkdir(join(earlyRepo, "deep", "nested"), { recursive: true });
    await mkdir(join(laterRepo, ".git"), { recursive: true });
    await writeFile(join(earlyRepo, "deep", "nested", "late.md"), "# Deep Early\n");
    await writeFile(join(laterRepo, "README.md"), "# Root Later\n");

    const index = await scanHtmlDocuments({
      root: tempRoot,
      roots: [tempRoot],
      maxDepth: 1,
      maxFiles: 1,
    });

    expect(index.documents.map((document) => document.title)).toEqual(["Root Later"]);
  });
});
