export const SOURCE_REFRESH_COOLDOWN_MS = 2000;

export type SourceRefreshState = {
  inFlight: Promise<unknown> | null;
  lastCompletedAt: number;
};

export function formatSourceDisplayPath(path: string): string {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  if (segments.length <= 2) return path;
  return `…/${segments.slice(-2).join("/")}`;
}

export function createSourceRefreshState(): SourceRefreshState {
  return { inFlight: null, lastCompletedAt: 0 };
}

export function canRefreshSources(now: number, state: SourceRefreshState): { ok: true } | { ok: false; status: 202 | 429; body: Record<string, unknown> } {
  if (state.inFlight) return { ok: false, status: 202, body: { error: "refresh in progress" } };
  const elapsed = now - state.lastCompletedAt;
  if (elapsed < SOURCE_REFRESH_COOLDOWN_MS) {
    return { ok: false, status: 429, body: { error: "refresh cooldown", retry_after_ms: SOURCE_REFRESH_COOLDOWN_MS - elapsed } };
  }
  return { ok: true };
}

export function normalizeLegacySourceStatus(status: string): "active" | "missing" {
  return status === "missing" ? "missing" : "active";
}

export function getMissingDiscoveredSourceKeys(discovered: readonly string[], existingDiscovered: readonly string[]): string[] {
  const discoveredSet = new Set(discovered);
  return existingDiscovered.filter((key) => !discoveredSet.has(key)).sort();
}

export function summarizeSourceRefresh(discovered: readonly { kind: string }[]): { total: number; kinds: Record<string, number> } {
  return discovered.reduce<{ total: number; kinds: Record<string, number> }>((summary, source) => {
    summary.total += 1;
    summary.kinds[source.kind] = (summary.kinds[source.kind] ?? 0) + 1;
    return summary;
  }, { total: 0, kinds: {} });
}

export function decideBeadsSourceRead(commitHash: string | null, previousCommitHash: string | null, haveSnapshot: boolean): { shouldSkipRead: boolean; source: "dolt" | "jsonl" } {
  const shouldSkipRead = Boolean(commitHash && previousCommitHash === commitHash && haveSnapshot);
  const source = commitHash ? "dolt" : "jsonl";
  return { shouldSkipRead, source };
}

export function buildBeadsSourceHealthEvent(projectId: string, commitHash: string | null, drift: boolean, healthy: boolean): { projectId: string; source: "dolt" | "jsonl"; drift: boolean; healthy: boolean } {
  return { projectId, source: commitHash ? "dolt" : "jsonl", drift, healthy };
}

export function buildSourceHealthChangedPayload(projectId: string, healthy: boolean, source: "dolt" | "jsonl"): { projectId: string; healthy: boolean; source: "dolt" | "jsonl" } {
  return { projectId, healthy, source };
}
