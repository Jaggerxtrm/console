import type { BeadIssue } from "../../../types/beads.ts";

export type FeedSearchResult = {
  issues: BeadIssue[];
  query: string;
  prefixMatchCount: number;
  titleMatchCount: number;
  totalMatches: number;
  durationMs: number;
};

const cache = new WeakMap<readonly BeadIssue[], Map<string, FeedSearchResult>>();

export function filterIssuesForFeed(issues: readonly BeadIssue[], rawQuery: string): FeedSearchResult {
  const startedAt = now();
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    return {
      issues: issues as BeadIssue[],
      query,
      prefixMatchCount: 0,
      titleMatchCount: 0,
      totalMatches: issues.length,
      durationMs: now() - startedAt,
    };
  }

  let byQuery = cache.get(issues);
  if (!byQuery) {
    byQuery = new Map();
    cache.set(issues, byQuery);
  }
  const cached = byQuery.get(query);
  if (cached) return cached;

  let prefixMatchCount = 0;
  let titleMatchCount = 0;
  const filtered = issues.filter((issue) => {
    const idMatches = issue.id.toLowerCase().startsWith(query);
    const titleMatches = issue.title.toLowerCase().includes(query);
    if (idMatches) prefixMatchCount += 1;
    if (titleMatches) titleMatchCount += 1;
    return idMatches || titleMatches;
  });
  const result = {
    issues: filtered,
    query,
    prefixMatchCount,
    titleMatchCount,
    totalMatches: filtered.length,
    durationMs: now() - startedAt,
  };
  byQuery.set(query, result);
  return result;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
