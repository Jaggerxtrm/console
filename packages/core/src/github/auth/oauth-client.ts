/**
 * GitHub OAuth endpoints used for the xtrm-console GitHub App user token:
 * device flow start/poll and refresh. Base URLs are configurable so tests can
 * point these at a fake GitHub server.
 *
 * Verified against GitHub docs 2026-09-16 (refreshing-user-access-tokens):
 * client_secret is required for refresh UNLESS the token was minted via the
 * device flow — which is the only mint path here. The secret is still sent
 * when configured, for robustness against app-settings changes.
 */

export interface GithubOauthConfig {
  clientId: string;
  clientSecret?: string | null;
  oauthBaseUrl: string; // default https://github.com
  apiBaseUrl: string; // default https://api.github.com
  fetchImpl?: typeof fetch;
}

export interface DeviceFlowStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number; // seconds
  interval: number; // seconds between token polls
}

export interface OauthTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
  error_uri?: string;
  interval?: number;
}

/** Terminal device-flow failures surfaced to the status state machine. */
export type DeviceFlowErrorCode = "expired_token" | "access_denied" | "unsupported_grant_type" | "network_error";

export class DeviceFlowError extends Error {
  constructor(readonly code: DeviceFlowErrorCode) {
    super(`device flow failed: ${code}`);
  }
}

export class TokenRefreshError extends Error {
  constructor(readonly code: string) {
    super(`token refresh failed: ${code}`);
  }
}

function formBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function oauthHeaders(): Record<string, string> {
  return { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "agent-forge/0.1.0" };
}

export async function requestDeviceCode(config: GithubOauthConfig): Promise<DeviceFlowStart> {
  const response = await (config.fetchImpl ?? fetch)(`${config.oauthBaseUrl}/login/device/code`, {
    method: "POST",
    headers: oauthHeaders(),
    body: formBody({ client_id: config.clientId }),
  });
  if (!response.ok) throw new DeviceFlowError("network_error");
  const body = await response.json() as Omit<DeviceFlowStart, "interval"> & { interval?: number };
  if (!body.device_code || !body.user_code) throw new DeviceFlowError("network_error");
  return {
    device_code: body.device_code,
    user_code: body.user_code,
    verification_uri: body.verification_uri,
    expires_in: body.expires_in,
    // GitHub guarantees >= 5 s between token polls
    interval: Math.max(5, body.interval ?? 5),
  };
}

export async function pollDeviceToken(config: GithubOauthConfig, deviceCode: string): Promise<OauthTokenResponse> {
  const response = await (config.fetchImpl ?? fetch)(`${config.oauthBaseUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: oauthHeaders(),
    body: formBody({ client_id: config.clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
  });
  if (!response.ok) throw new DeviceFlowError("network_error");
  return await response.json() as OauthTokenResponse;
}

export async function refreshUserToken(config: GithubOauthConfig, refreshToken: string): Promise<Omit<OauthTokenResponse, "access_token"> & { access_token: string }> {
  const params: Record<string, string> = { client_id: config.clientId, grant_type: "refresh_token", refresh_token: refreshToken };
  // Optional per GitHub docs for device-flow-minted tokens; sent when present.
  if (config.clientSecret) params.client_secret = config.clientSecret;
  const response = await (config.fetchImpl ?? fetch)(`${config.oauthBaseUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: oauthHeaders(),
    body: formBody(params),
  });
  if (!response.ok) throw new TokenRefreshError(`http_${response.status}`);
  const body = await response.json() as OauthTokenResponse;
  if (body.error || !body.access_token) throw new TokenRefreshError(body.error ?? "no_token");
  return body as Omit<OauthTokenResponse, "access_token"> & { access_token: string };
}

export interface GithubUser {
  login: string;
  name: string | null;
  avatar_url: string | null;
}

export async function fetchGithubUser(config: GithubOauthConfig, token: string): Promise<GithubUser> {
  const response = await (config.fetchImpl ?? fetch)(`${config.apiBaseUrl}/user`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "agent-forge/0.1.0" },
  });
  if (!response.ok) throw new Error(`GitHub API error ${response.status}: /user`);
  const user = await response.json() as { login: string; name: string | null; avatar_url: string | null };
  return { login: user.login, name: user.name ?? null, avatar_url: user.avatar_url ?? null };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
