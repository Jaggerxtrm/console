export { canRefreshSources, createSourceRefreshState, formatSourceDisplayPath, SOURCE_REFRESH_COOLDOWN_MS } from "../../../../../packages/core/src/runtime/source-lifecycle-policy.ts";

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const ALLOWED_KINDS = ["beads", "observability"] as const;

export type AllowedSourceKind = (typeof ALLOWED_KINDS)[number];

export function isLocalhost(host: string): boolean {
  return LOCALHOST_HOSTS.has(normalizeLocalhostHost(host));
}

function normalizeLocalhostHost(host: string): string {
  const normalizedHost = host.trim().toLowerCase();

  try {
    const parsedHost = new URL(normalizedHost.includes("://") ? normalizedHost : `http://${normalizedHost}`).hostname;
    return parsedHost.startsWith("[") && parsedHost.endsWith("]") ? parsedHost.slice(1, -1) : parsedHost;
  } catch {
    if (normalizedHost === "::1") return normalizedHost;
    const bracketedIpv6Match = normalizedHost.match(/^\[(.+)\](?::\d+)?$/);
    if (bracketedIpv6Match) return bracketedIpv6Match[1] ?? normalizedHost;
    return normalizedHost.replace(/:\d+$/, "");
  }
}

export function isAllowedSourceKind(kind: string): kind is AllowedSourceKind {
  return ALLOWED_KINDS.includes(kind as AllowedSourceKind);
}

const ADMIN_TOKEN_ENV_NAMES = {
  primary: "CONSOLE_WRITE_ADMIN_TOKEN",
  legacy: "GITBOARD_SOURCES_ADMIN_TOKEN",
} as const;

// Console write authorization policy:
// - accept local/same-origin write requests only.
// - remote/demo write endpoints remain effectively read-only without real auth.
// - use actor value `console` in docs and new routes.
// - primary token/env is CONSOLE_WRITE_ADMIN_TOKEN with x-console-write-token header;
//   legacy compatibility uses GITBOARD_SOURCES_ADMIN_TOKEN / x-gitboard-sources-admin-token.
// - force:true termination is intentionally deferred to specialists-control route for now.
export function isAllowedConsoleWriteRequest(
  url: string,
  host: string,
  origin: string | null,
  requestToken: string | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const requestUrl = new URL(url);
  if (!isLocalhost(host) || !isLocalhost(requestUrl.hostname)) return false;

  const configuredToken = env[ADMIN_TOKEN_ENV_NAMES.primary] ?? env[ADMIN_TOKEN_ENV_NAMES.legacy] ?? "";
  const tokenFromPrimaryHeader = requestToken;

  if (!origin) {
    return configuredToken.length > 0 && tokenFromPrimaryHeader === configuredToken;
  }

  try {
    const originUrl = new URL(origin);
    const hasSameOrigin = originUrl.hostname === requestUrl.hostname && originUrl.port === requestUrl.port && originUrl.protocol === requestUrl.protocol;
    return hasSameOrigin;
  } catch {
    return false;
  }
}

// Compatibility alias for existing callers until their route migrations finish.
export function isAllowedMutationRequest(url: string, host: string, origin: string | null, requestToken: string | null): boolean {
  return isAllowedConsoleWriteRequest(url, host, origin, requestToken, process.env);
}
