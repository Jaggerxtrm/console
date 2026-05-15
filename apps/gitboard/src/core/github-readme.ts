import { getGithubToken } from "./github-poller.ts";

interface ContentEntry {
  content: string;
  sha: string;
  last_modified: string | null;
}

interface DirEntry {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: "file" | "dir";
}

const TTL_MS = 10 * 60 * 1000;
const fileCache = new Map<string, { value: ContentEntry; expires: number }>();
const dirCache = new Map<string, { value: DirEntry[]; expires: number }>();

function cacheKey(owner: string, repo: string, path: string): string {
  return `${owner}/${repo}::${path}`;
}

async function ghFetch(url: string): Promise<Response> {
  const token = getGithubToken();
  return fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gitboard",
    },
  });
}

export async function fetchRepoFile(
  owner: string,
  repo: string,
  path: string,
): Promise<ContentEntry | null> {
  const key = cacheKey(owner, repo, path);
  const cached = fileCache.get(key);
  const now = Date.now();
  if (cached && cached.expires > now) return cached.value;

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const res = await ghFetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub Contents ${res.status} for ${owner}/${repo}/${path}`);

  const json = (await res.json()) as {
    content?: string;
    encoding?: string;
    sha: string;
  };
  const decoded =
    json.encoding === "base64" && json.content
      ? Buffer.from(json.content, "base64").toString("utf-8")
      : (json.content ?? "");

  const value: ContentEntry = {
    content: decoded,
    sha: json.sha,
    last_modified: res.headers.get("last-modified"),
  };
  fileCache.set(key, { value, expires: now + TTL_MS });
  return value;
}

export async function listRepoDir(
  owner: string,
  repo: string,
  path: string,
): Promise<DirEntry[]> {
  const key = cacheKey(owner, repo, `dir:${path}`);
  const cached = dirCache.get(key);
  const now = Date.now();
  if (cached && cached.expires > now) return cached.value;

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const res = await ghFetch(url);
  if (res.status === 404) {
    dirCache.set(key, { value: [], expires: now + TTL_MS });
    return [];
  }
  if (!res.ok) throw new Error(`GitHub Contents ${res.status} for ${owner}/${repo}/${path}`);

  const json = (await res.json()) as DirEntry[] | DirEntry;
  const entries = Array.isArray(json) ? json : [json];
  dirCache.set(key, { value: entries, expires: now + TTL_MS });
  return entries;
}

export function clearReadmeCache(): void {
  fileCache.clear();
  dirCache.clear();
}

export function parseFrontmatter(text: string): Record<string, string> | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const block = text.slice(3, end).trim();
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return Object.keys(out).length > 0 ? out : null;
}
