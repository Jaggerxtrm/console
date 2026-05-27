import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { HtmlDocumentEntry, PreviewIndex, RepoEntry } from "./types.ts";

const DEFAULT_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".turbo",
  ".next",
  ".nuxt",
  ".cache",
  ".parcel-cache",
  "node_modules",
  "vendor",
]);

export interface ScanOptions {
  root: string;
  maxDepth: number;
  maxFiles: number;
}

export async function scanHtmlDocuments(options: ScanOptions): Promise<PreviewIndex> {
  const root = options.root;
  const repos = await findRepos(root, options.maxDepth);
  const documents: HtmlDocumentEntry[] = [];

  for (const repo of repos) {
    const repoDocuments = await findHtmlFiles(repo, options.maxFiles - documents.length);
    documents.push(...repoDocuments);
    if (documents.length >= options.maxFiles) {
      break;
    }
  }

  documents.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));

  return {
    root,
    generatedAt: new Date().toISOString(),
    repos,
    documents,
  };
}

async function findRepos(root: string, maxDepth: number): Promise<RepoEntry[]> {
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
        id: makeRepoId(relativePath),
        name: basename(dir),
        path: dir,
        relativePath,
      });
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || DEFAULT_SKIP_DIRS.has(entry.name)) {
        continue;
      }
      await walk(join(dir, entry.name), depth + 1);
    }
  }

  await walk(root, 0);
  repos.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return repos;
}

async function findHtmlFiles(repo: RepoEntry, remaining: number): Promise<HtmlDocumentEntry[]> {
  const documents: HtmlDocumentEntry[] = [];

  async function walk(dir: string): Promise<void> {
    if (documents.length >= remaining) {
      return;
    }

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (documents.length >= remaining) {
        return;
      }

      const absolutePath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!DEFAULT_SKIP_DIRS.has(entry.name)) {
          await walk(absolutePath);
        }
        continue;
      }

      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".html")) {
        continue;
      }

      const fileStat = await stat(absolutePath);
      const repoRelativePath = relative(repo.path, absolutePath).split("\\").join("/");
      documents.push({
        id: `${repo.id}:${repoRelativePath}`,
        repoId: repo.id,
        repoName: repo.name,
        repoPath: repo.path,
        path: repoRelativePath,
        title: await readHtmlTitle(absolutePath, entry.name),
        size: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString(),
      });
    }
  }

  await walk(repo.path);
  return documents;
}

async function readHtmlTitle(path: string, fallback: string): Promise<string> {
  try {
    const file = await readFile(path, "utf8");
    const match = file.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return normalizeTitle(match?.[1] ?? fallback);
  } catch {
    return fallback;
  }
}

function normalizeTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : "Untitled HTML";
}

function makeRepoId(relativePath: string): string {
  return relativePath
    .replace(/^\.$/, "root")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}
