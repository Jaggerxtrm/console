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
  const requestHost = normalizeLocalhostHost(host);
  if (!isLocalhost(requestHost) || !isLocalhost(requestUrl.hostname)) return false;

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
