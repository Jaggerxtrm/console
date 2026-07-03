import type { BeadIssue } from "../../../types/beads.ts";

export type FeedSearchReason = "id" | "title" | "description" | "notes" | "label" | "dependency" | "related";

export type FeedSearchMatch = {
  reason: FeedSearchReason;
  label: string;
  snippet: string;
  score: number;
};

export type FeedSearchResult = {
  issues: BeadIssue[];
  query: string;
  prefixMatchCount: number;
  titleMatchCount: number;
  totalMatches: number;
  durationMs: number;
  matchByIssueId: Map<string, FeedSearchMatch>;
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
      matchByIssueId: new Map(),
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
  const matchByIssueId = new Map<string, FeedSearchMatch>();
  const ranked: Array<{ issue: BeadIssue; match: FeedSearchMatch }> = [];
  for (const issue of issues) {
    const match = scoreIssue(issue, query);
    if (!match) continue;
    if (match.reason === "id" && issue.id.toLowerCase().startsWith(query)) prefixMatchCount += 1;
    if (match.reason === "title") titleMatchCount += 1;
    matchByIssueId.set(issue.id, match);
    ranked.push({ issue, match });
  }
  const filtered = ranked
    .sort((a, b) => b.match.score - a.match.score || a.issue.id.localeCompare(b.issue.id))
    .map((item) => item.issue);
  const result = {
    issues: filtered,
    query,
    prefixMatchCount,
    titleMatchCount,
    totalMatches: filtered.length,
    durationMs: now() - startedAt,
    matchByIssueId,
  };
  byQuery.set(query, result);
  return result;
}

function scoreIssue(issue: BeadIssue, query: string): FeedSearchMatch | null {
  const fields: SearchField[] = [
    { reason: "id", label: "id", text: issue.id, base: 120 },
    { reason: "title", label: "title", text: issue.title, base: 110 },
    { reason: "description", label: "description", text: issue.description ?? "", base: 80 },
    { reason: "notes", label: "notes", text: issue.notes ?? "", base: 78 },
    { reason: "label", label: "label", text: (issue.labels ?? []).join(" "), base: 72 },
    { reason: "dependency", label: "dependency", text: issue.dependencies.map((dep) => `${dep.id} ${dep.title ?? ""} ${dep.dependency_type}`).join(" "), base: 66 },
    { reason: "related", label: "related", text: (issue.related_ids ?? []).join(" "), base: 62 },
  ];
  let best: FeedSearchMatch | null = null;
  for (const field of fields) {
    const score = scorePhrase(field.text, query, field.base);
    if (score === 0) continue;
    const match = { reason: field.reason, label: field.label, snippet: snippetFor(field.text, query), score };
    if (!best || match.score > best.score) best = match;
  }

  const tokenMatch = scoreTokens(fields, query);
  if (best && tokenMatch && tokenMatch.score > best.score) return { ...best, score: tokenMatch.score };
  if (tokenMatch && !best) return tokenMatch;
  return best;
}

type SearchField = {
  reason: FeedSearchReason;
  label: string;
  text: string;
  base: number;
};

function scorePhrase(text: string, query: string, base: number): number {
  const haystack = normalize(text);
  if (!haystack) return 0;
  if (haystack === query) return base + 40;
  if (haystack.startsWith(query)) return base + 30;
  if (haystack.includes(query)) return base + 20;
  return 0;
}

function scoreTokens(fields: SearchField[], query: string): FeedSearchMatch | null {
  const queryTokens = query.split(/\s+/).filter(Boolean);
  if (queryTokens.length === 0) return null;

  let total = 0;
  const fieldHits = new Map<FeedSearchReason, { field: SearchField; score: number; tokens: string[] }>();

  for (const token of queryTokens) {
    let best: { field: SearchField; score: number } | null = null;
    for (const field of fields) {
      const score = scoreToken(field.text, token, field.base);
      if (score === 0) continue;
      if (!best || score > best.score) best = { field, score };
    }
    if (!best) return null;
    total += best.score;
    const hit = fieldHits.get(best.field.reason);
    if (hit) {
      hit.score += best.score;
      hit.tokens.push(token);
    } else {
      fieldHits.set(best.field.reason, { field: best.field, score: best.score, tokens: [token] });
    }
  }

  const strongest = [...fieldHits.values()].sort((left, right) => right.tokens.length - left.tokens.length || right.score - left.score || right.field.base - left.field.base)[0];
  if (!strongest) return null;
  const coverageBonus = fieldHits.size === 1 ? 12 : 6;
  return {
    reason: strongest.field.reason,
    label: strongest.field.label,
    snippet: snippetFor(strongest.field.text, strongest.tokens[0] ?? query),
    score: Math.round(total / queryTokens.length) + coverageBonus,
  };
}

function scoreToken(text: string, token: string, base: number): number {
  const haystack = normalize(text);
  if (!haystack) return 0;
  const words = wordsFor(haystack);
  let best = 0;
  for (const word of words) {
    if (word === token) best = Math.max(best, base + (haystack.startsWith(token) ? 18 : 14));
    else if (token.length >= 2 && word.startsWith(token)) best = Math.max(best, base + 10);
    else if (token.length >= 3 && word.includes(token)) best = Math.max(best, base + 7);
    else if (isTypoMatch(word, token)) best = Math.max(best, base + 4);
  }
  return best;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function wordsFor(value: string): string[] {
  return value.split(/[^a-z0-9.:-]+/).filter(Boolean);
}

function isTypoMatch(word: string, query: string): boolean {
  if (query.length < 4) return false;
  if (Math.abs(word.length - query.length) > 2) return false;
  return levenshtein(word, query, 2) <= (query.length > 7 ? 2 : 1);
}

function levenshtein(left: string, right: string, max: number): number {
  let prev = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMin = current[0];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const next = Math.min(prev[j] + 1, current[j - 1] + 1, prev[j - 1] + cost);
      current[j] = next;
      rowMin = Math.min(rowMin, next);
    }
    if (rowMin > max) return rowMin;
    prev = current;
  }
  return prev[right.length] ?? max + 1;
}

function snippetFor(text: string, query: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  const lower = compact.toLowerCase();
  const index = lower.indexOf(query);
  if (index === -1) return compact.slice(0, 96);
  const start = Math.max(0, index - 28);
  const end = Math.min(compact.length, index + query.length + 52);
  return `${start > 0 ? "..." : ""}${compact.slice(start, end)}${end < compact.length ? "..." : ""}`;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
