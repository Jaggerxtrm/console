const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
export const TRUSTED_PEER_ADDRESS_HEADER = "x-xtrm-peer-address";

export function isLocalhost(host: string): boolean {
  return LOCALHOST_HOSTS.has(normalizeLocalhostHost(host));
}

export function isLoopbackAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase().replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1";
}

export function isTrustedLocalhostRequest(url: string, host: string, peerAddress?: string | null): boolean {
  const requestUrl = new URL(url);
  return isLocalhost(host)
    && isLocalhost(requestUrl.hostname)
    && (!peerAddress || isLoopbackAddress(peerAddress));
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

const ADMIN_TOKEN_ENV_NAMES = {
  primary: "CONSOLE_WRITE_ADMIN_TOKEN",
  legacy: "GITBOARD_SOURCES_ADMIN_TOKEN",
} as const;

export type MutablePinnedSourceKind = "beads" | "observability";

export function isAllowedPinnedSourceKind(kind: string): kind is MutablePinnedSourceKind {
  return kind === "beads" || kind === "observability";
}

export function isAllowedConsoleWriteRequest(
  url: string,
  host: string,
  origin: string | null,
  requestToken: string | null,
  env: NodeJS.ProcessEnv = process.env,
  peerAddress?: string | null,
): boolean {
  const requestUrl = new URL(url);
  if (!isTrustedLocalhostRequest(url, host, peerAddress)) return false;

  const configuredToken = env[ADMIN_TOKEN_ENV_NAMES.primary] ?? env[ADMIN_TOKEN_ENV_NAMES.legacy] ?? "";
  if (!origin) {
    return configuredToken.length > 0 && requestToken === configuredToken;
  }

  try {
    const originUrl = new URL(origin);
    return originUrl.hostname === requestUrl.hostname
      && originUrl.port === requestUrl.port
      && originUrl.protocol === requestUrl.protocol;
  } catch {
    return false;
  }
}

export function isAllowedMutationRequest(
  url: string,
  host: string,
  origin: string | null,
  requestToken: string | null,
  peerAddress?: string | null,
): boolean {
  return isAllowedConsoleWriteRequest(url, host, origin, requestToken, process.env, peerAddress);
}
