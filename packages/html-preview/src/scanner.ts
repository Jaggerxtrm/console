import { open, readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import type { DocumentEntry, DocumentKind, PreviewIndex, RepoEntry } from "./types.ts";

const DEFAULT_SKIP_DIRS = new Set([
  ".agent",
  ".agents",
  ".beads",
  ".cache",
  ".claude",
  ".gemini",
  ".git",
  ".hg",
  ".mypy_cache",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".pytest_cache",
  ".qwen",
  ".ruff_cache",
  ".serena",
  ".specialists",
  ".svn",
  ".tox",
  ".turbo",
  ".venv",
  ".worktrees",
  ".xtrm",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "env",
  "htmlcov",
  "node_modules",
  "out",
  "target",
  "vendor",
  "venv",
]);

const DOCUMENT_KINDS: Record<string, DocumentKind> = {
  ".html": "html",
  ".htm": "html",
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdown": "markdown",
  ".txt": "text",
};

const DEFAULT_SKIP_SUBTREES = new Set(["ingestion/articles"]);

const TITLE_READ_BYTES = 16 * 1024;
const REPO_SCAN_CONCURRENCY = 4;

export interface ScanOptions {
  root: string;
  roots?: string[];
  maxDepth: number;
  maxFiles: number;
  excludeDirs?: string[];
  excludeSubtrees?: string[];
}

export async function scanHtmlDocuments(options: ScanOptions): Promise<PreviewIndex> {
  const roots = normalizeRoots(options.roots?.length ? options.roots : [options.root]);
  const skipDirs = buildSkipDirs(options.excludeDirs);
  const skipSubtrees = buildSkipSubtrees(options.excludeSubtrees);
  const repos = (await Promise.all(roots.map((root) => findRepos(root, options.maxDepth, skipDirs)))).flat();
  const documents = (await mapLimit(repos, REPO_SCAN_CONCURRENCY, (repo) => findDocumentFiles(repo, skipDirs, skipSubtrees))).flat();

  documents.sort((a, b) => {
    if (a.proximity !== b.proximity) {
      return a.proximity - b.proximity;
    }
    return b.modifiedAt.localeCompare(a.modifiedAt) || a.displayPath.localeCompare(b.displayPath);
  });

  return {
    root: roots.join(", "),
    roots,
    generatedAt: new Date().toISOString(),
    repos,
    documents: documents.slice(0, options.maxFiles),
  };
}

async function findRepos(root: string, maxDepth: number, skipDirs: Set<string>): Promise<RepoEntry[]> {
  const repos: RepoEntry[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      return;
    }

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (entries.some((entry) => entry.isDirectory() && entry.name === ".git")) {
      const relativePath = relative(root, dir) || ".";
      repos.push({
        id: makeRepoId(root, relativePath),
        name: basename(dir),
        root,
        path: dir,
        absolutePath: dir,
        relativePath,
      });
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || shouldSkipDir(entry.name, skipDirs)) {
        continue;
      }
      await walk(join(dir, entry.name), depth + 1);
    }
  }

  await walk(root, 0);
  repos.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return repos;
}

async function findDocumentFiles(repo: RepoEntry, skipDirs: Set<string>, skipSubtrees: Set<string>): Promise<DocumentEntry[]> {
  const documents: DocumentEntry[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath = join(dir, entry.name);

      if (entry.isDirectory()) {
        const repoRelativeDir = relative(repo.path, absolutePath).split("\\").join("/");
        if (!shouldSkipDir(entry.name, skipDirs) && !shouldSkipSubtree(repoRelativeDir, skipSubtrees)) {
          await walk(absolutePath);
        }
        continue;
      }

      const kind = DOCUMENT_KINDS[extname(entry.name).toLowerCase()];
      if (!entry.isFile() || !kind) {
        continue;
      }

      let fileStat;
      try {
        fileStat = await stat(absolutePath);
      } catch {
        continue;
      }

      const repoRelativePath = relative(repo.path, absolutePath).split("\\").join("/");
      const folderPath = getFolderPath(repoRelativePath);
      documents.push({
        id: `${repo.id}:${repoRelativePath}`,
        repoId: repo.id,
        repoName: repo.name,
        repoPath: repo.path,
        absolutePath,
        path: repoRelativePath,
        folderPath,
        displayPath: absolutePath,
        kind,
        title: await readDocumentTitle(absolutePath, entry.name, kind),
        size: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString(),
        proximity: calculateProximity(repo, repoRelativePath),
      });
    }
  }

  await walk(repo.path);
  return documents;
}

async function readDocumentTitle(path: string, fallback: string, kind: DocumentKind): Promise<string> {
  if (kind === "html") {
    return readHtmlTitle(path, fallback);
  }

  if (kind === "markdown") {
    return readMarkdownTitle(path, fallback);
  }

  return fallback;
}

async function readHtmlTitle(path: string, fallback: string): Promise<string> {
  try {
    const file = await readFilePrefix(path, TITLE_READ_BYTES);
    const match = file.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return normalizeTitle(match?.[1] ?? fallback);
  } catch {
    return fallback;
  }
}

async function readMarkdownTitle(path: string, fallback: string): Promise<string> {
  try {
    const file = await readFilePrefix(path, TITLE_READ_BYTES);
    const heading = file.split(/\r?\n/).find((line) => /^#\s+/.test(line));
    return normalizeTitle(heading?.replace(/^#\s+/, "") ?? fallback);
  } catch {
    return fallback;
  }
}

async function readFilePrefix(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const result = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, result.bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function normalizeTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : "Untitled HTML";
}

function calculateProximity(repo: RepoEntry, repoRelativePath: string): number {
  const repoDepth = repo.relativePath === "." ? 0 : repo.relativePath.split(/[\\/]/).length;
  const documentDepth = repoRelativePath.split("/").length - 1;
  return repoDepth * 10 + documentDepth;
}

function getFolderPath(repoRelativePath: string): string {
  const parts = repoRelativePath.split("/");
  parts.pop();
  return parts.length > 0 ? parts.join("/") : ".";
}

function normalizeRoots(roots: string[]): string[] {
  return [...new Set(roots.map((root) => root.trim()).filter(Boolean))];
}

function buildSkipDirs(excludeDirs?: string[]): Set<string> {
  return new Set([...DEFAULT_SKIP_DIRS, ...(excludeDirs ?? [])].map((entry) => entry.trim()).filter(Boolean));
}

function buildSkipSubtrees(excludeSubtrees?: string[]): Set<string> {
  return new Set([...DEFAULT_SKIP_SUBTREES, ...(excludeSubtrees ?? [])]
    .map((entry) => entry.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase())
    .filter(Boolean));
}

function shouldSkipDir(name: string, skipDirs: Set<string>): boolean {
  return name.startsWith(".") || skipDirs.has(name) || skipDirs.has(name.toLowerCase());
}

function shouldSkipSubtree(repoRelativeDir: string, skipSubtrees: Set<string>): boolean {
  const normalized = repoRelativeDir.toLowerCase();
  return skipSubtrees.has(normalized) || [...skipSubtrees].some((subtree) => normalized.startsWith(`${subtree}/`));
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function makeRepoId(root: string, relativePath: string): string {
  return `${basename(root)}-${relativePath}`
    .replace(/-\.$/, "-root")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}
