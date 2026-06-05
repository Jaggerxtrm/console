// ─── Date grouping ────────────────────────────────────────────────────────────

export type DateGroupHeader = { kind: "header"; label: string; key: string };
export type DateGroupRow<T> = { kind: "row"; item: T };
export type DateGroupItem<T> = DateGroupHeader | DateGroupRow<T>;

export function buildDateGroupedItems<T>(
  items: T[],
  getDate: (item: T) => string,
): DateGroupItem<T>[] {
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86_400_000).toDateString();
  const result: DateGroupItem<T>[] = [];
  let lastDate = "";

  for (const item of items) {
    const d = new Date(getDate(item));
    const ds = d.toDateString();
    if (ds !== lastDate) {
      lastDate = ds;
      const label =
        ds === today ? "Today"
        : ds === yesterday ? "Yesterday"
        : d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
      result.push({ kind: "header", label, key: `header-${ds}` });
    }
    result.push({ kind: "row", item });
  }
  return result;
}

// ─── Relative time ────────────────────────────────────────────────────────────

export function formatRelativeTime(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 2_592_000_000) return `${Math.floor(diff / 86_400_000)}d ago`;
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

// ─── Label parsing ────────────────────────────────────────────────────────────

export function parseLabels(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// ─── Body truncation ──────────────────────────────────────────────────────────

export const BODY_MAX_CHARS = 300;

export function truncateBody(
  text: string,
  max = BODY_MAX_CHARS,
): { visible: string; hasMore: boolean } {
  if (text.length <= max) return { visible: text, hasMore: false };
  return { visible: text.slice(0, max), hasMore: true };
}
