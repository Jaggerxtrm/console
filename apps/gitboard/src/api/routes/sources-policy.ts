export { canRefreshSources, createSourceRefreshState, formatSourceDisplayPath, SOURCE_REFRESH_COOLDOWN_MS } from "../../../../../packages/core/src/runtime/source-lifecycle-policy.ts";

const LOCALHOST_PREFIXES = ["localhost", "127.0.0.1", "[::1]"];
const ALLOWED_KINDS = ["beads", "observability"] as const;

export type AllowedSourceKind = (typeof ALLOWED_KINDS)[number];

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
