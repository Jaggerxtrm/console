export const SOURCE_REFRESH_COOLDOWN_MS = 2000;

const LOCALHOST_PREFIXES = ["localhost", "127.0.0.1", "[::1]"];
const ALLOWED_KINDS = ["beads", "observability"] as const;

export type AllowedSourceKind = (typeof ALLOWED_KINDS)[number];

export type SourceRefreshState = {
  inFlight: Promise<unknown> | null;
  lastCompletedAt: number;
};

export function isLocalhost(host: string): boolean {
  return LOCALHOST_PREFIXES.some((prefix) => host.startsWith(prefix));
}

function normalizeLocalhostHost(host: string): string {
  try {
    return new URL(host).hostname;
  } catch {
    return host.split(":")[0] ?? host;
  }
}

export function isAllowedSourceKind(kind: string): kind is AllowedSourceKind {
  return ALLOWED_KINDS.includes(kind as AllowedSourceKind);
}

export function isAllowedMutationRequest(url: string, host: string, origin: string | null, requestToken: string | null): boolean {
  const requestUrl = new URL(url);
  const requestHost = normalizeLocalhostHost(host);
  if (!isLocalhost(requestHost) || !isLocalhost(requestUrl.hostname)) return false;
  if (!origin) {
    const configuredToken = process.env.GITBOARD_SOURCES_ADMIN_TOKEN ?? "";
    return configuredToken.length > 0 && requestToken !== null && requestToken === configuredToken;
  }
  try {
    const originUrl = new URL(origin);
    return originUrl.hostname === requestUrl.hostname && originUrl.port === requestUrl.port && originUrl.protocol === requestUrl.protocol;
  } catch {
    return false;
  }
}

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
