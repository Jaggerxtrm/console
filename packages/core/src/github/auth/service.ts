/**
 * GitHub App user-auth service: device flow orchestration, token storage,
 * refresh-before-expiry, and the auth status state machine.
 *
 * States: not_configured (no client id) | signed_out | pending | signed_in |
 * expired | error. Tokens, refresh tokens, and device codes never leave this
 * module except into the token store; status responses carry only identity
 * and device UX fields (user_code, verification_uri).
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasSharedToken, invalidateGithubCredential, setUserTokenProvider } from "../token.ts";
import { resolveTokenStore, type StoredUserToken, type TokenStore } from "./store.ts";
import {
  DeviceFlowError,
  fetchGithubUser,
  pollDeviceToken,
  refreshUserToken,
  requestDeviceCode,
  sleep,
  type DeviceFlowStart,
  type GithubOauthConfig,
  type GithubUser,
  type OauthTokenResponse,
} from "./oauth-client.ts";

/** Refresh when less than this remains of the access token lifetime. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_APP_SLUG = "xtrm-console";

export type GithubAuthState = "not_configured" | "signed_out" | "pending" | "signed_in" | "expired" | "error";

export interface GithubAuthStatus {
  state: GithubAuthState;
  auth_source: "user" | "shared" | "none";
  store: "keychain" | "file";
  user?: { login: string; name: string | null; avatar_url: string | null };
  device?: { user_code: string; verification_uri: string; expires_at: string; interval: number };
  error?: { code: string; message: string };
}

export interface GithubInstallation {
  id: number;
  account: { login: string; avatar_url: string | null; html_url: string | null };
  repository_selection: string;
  permissions: Record<string, string>;
  html_url: string;
}

export interface GithubAuthServiceOptions {
  env?: NodeJS.ProcessEnv;
  store?: TokenStore;
  fileStoreBaseDir?: string;
  /** Register this service as the process-wide user-token provider. Default true. */
  registerTokenProvider?: boolean;
  fetchImpl?: typeof fetch;
  /** Injectable shared-token probe for deterministic tests. */
  sharedTokenAvailable?: () => boolean;
}

let clientSecretCache: { file: string; value: string | null } | undefined;
let defaultService: GithubAuthService | null = null;

async function loadClientSecret(env: NodeJS.ProcessEnv): Promise<string | null> {
  if (env.XTRM_GITHUB_APP_CLIENT_SECRET) return env.XTRM_GITHUB_APP_CLIENT_SECRET;
  const file = env.XTRM_GITHUB_APP_CLIENT_SECRET_FILE
    ?? join(homedir(), ".secrets", "XTRM_GITHUB_APP_CLIENT_SECRET.txt");
  if (clientSecretCache !== undefined && file === clientSecretCache.file) return clientSecretCache.value;
  try {
    const value = (await readFile(file, "utf8")).trim();
    clientSecretCache = { file, value };
    return value || null;
  } catch {
    clientSecretCache = { file, value: null };
    return null;
  }}

export function createGithubAuthService(options: GithubAuthServiceOptions = {}): GithubAuthService {
  // Empty options = the process-wide default (one store probe, one provider).
  if (defaultService && Object.keys(options).length === 0) return defaultService;
  const service = buildGithubAuthService(options);
  if (Object.keys(options).length === 0) defaultService = service;
  return service;
}

function buildGithubAuthService(options: GithubAuthServiceOptions) {
  const env = options.env ?? process.env;
  let store: TokenStore | null = options.store ?? null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sharedTokenAvailable = options.sharedTokenAvailable ?? hasSharedToken;
  const clientId = env.XTRM_GITHUB_APP_CLIENT_ID ?? null;
  const appSlug = env.XTRM_GITHUB_APP_SLUG ?? DEFAULT_APP_SLUG;
  const oauthBaseUrl = env.XTRM_GITHUB_OAUTH_BASE_URL ?? "https://github.com";
  const apiBaseUrl = env.XTRM_GITHUB_API_BASE_URL ?? "https://api.github.com";

  let pendingFlow: (DeviceFlowStart & { expiresAt: number; cancelled: boolean }) | null = null;
  let record: StoredUserToken | null = null;
  let loaded = false;
  let lastError: { code: string; message: string } | null = null;
  let refreshing: Promise<string | null> | null = null;

  function oauthConfig(secret: string | null): GithubOauthConfig {
    return { clientId: clientId ?? "", clientSecret: secret, oauthBaseUrl, apiBaseUrl, fetchImpl };
  }

  async function ensureLoaded(): Promise<void> {
    if (!loaded) {
      loaded = true;
      if (!store) store = await resolveTokenStore(env, options.fileStoreBaseDir);
      try {
        record = await store.get();
      } catch {
        record = null;
      }
    }
  }

  function isExpired(rec: StoredUserToken, at = Date.now()): boolean {
    if (!rec.expires_at) return false;
    return Date.parse(rec.expires_at) <= at;
  }

  function authSource(): "user" | "shared" | "none" {
    if (record && !isExpired(record)) return "user";
    return sharedTokenAvailable() ? "shared" : "none";
  }

  /** Refresh the stored token when it is expired or close to expiring. */
  async function getValidUserToken(): Promise<string | null> {
    await ensureLoaded();
    if (!record) return null;
    if (!isExpired(record) && (record.expires_at === null || Date.parse(record.expires_at) - Date.now() > REFRESH_MARGIN_MS)) return record.access_token;
    if (!record.refresh_token || !clientId) return null; // expired and not refreshable (refresh requires the app client id)
    if (!refreshing) {
      refreshing = (async () => {
        try {
          const secret = await loadClientSecret(env);
          const body = await refreshUserToken(oauthConfig(secret), record!.refresh_token!);
          record = recordFromResponse(body, record!.user);
          await store!.set(record);
          lastError = null;
          invalidateGithubCredential();
          return record.access_token;
        } catch {
          lastError = { code: "refresh_failed", message: "user token refresh failed; token is expired" };
          invalidateGithubCredential();
          return null;
        } finally {
          refreshing = null;
        }
      })();
    }
    return refreshing;
  }

  function recordFromResponse(body: Omit<OauthTokenResponse, "access_token"> & { access_token: string }, user: GithubUser | null): StoredUserToken {
    const now = Date.now();
    return {
      access_token: body.access_token,
      refresh_token: body.refresh_token ?? record?.refresh_token ?? null,
      expires_at: body.expires_in ? new Date(now + body.expires_in * 1000).toISOString() : null,
      refresh_expires_at: body.refresh_token_expires_in ? new Date(now + body.refresh_token_expires_in * 1000).toISOString() : null,
      obtained_at: new Date(now).toISOString(),
      user,
    };
  }

  async function startDeviceFlow(): Promise<{ ok: true; device: DeviceFlowStart } | { ok: false; error: { code: string; message: string } }> {
    await ensureLoaded();
    if (!clientId) return { ok: false, error: { code: "not_configured", message: "XTRM_GITHUB_APP_CLIENT_ID is not set" } };
    if (pendingFlow && pendingFlow.expiresAt > Date.now() && !pendingFlow.cancelled) {
      return { ok: true, device: pendingFlow };
    }
    let device: DeviceFlowStart;
    try {
      device = await requestDeviceCode(oauthConfig(await loadClientSecret(env)));
    } catch (error) {
      lastError = { code: error instanceof DeviceFlowError ? error.code : "network_error", message: "device flow could not start" };
      return { ok: false, error: lastError };
    }
    const flow = { ...device, expiresAt: Date.now() + device.expires_in * 1000, cancelled: false };
    pendingFlow = flow;
    lastError = null;
    void runDevicePoll(flow).catch(() => {});
    return { ok: true, device };
  }

  async function runDevicePoll(flow: DeviceFlowStart & { expiresAt: number; cancelled: boolean }): Promise<void> {
    let interval = flow.interval;
    while (!flow.cancelled && Date.now() < flow.expiresAt) {
      await sleep(interval * 1000);
      if (flow.cancelled) break;
      let body;
      try {
        body = await pollDeviceToken(oauthConfig(await loadClientSecret(env)), flow.device_code);
      } catch {
        lastError = { code: "network_error", message: "device flow poll failed" };
        break;
      }
      if (body.error === "authorization_pending") continue;
      if (body.error === "slow_down") {
        // Constraint: add 5 s on slow_down, never poll faster than returned interval.
        interval = Math.max(interval + 5, body.interval ?? interval + 5);
        continue;
      }
      if (body.error === "expired_token" || body.error === "access_denied") {
        lastError = { code: body.error, message: body.error === "expired_token" ? "device code expired before authorization" : "authorization was denied" };
        break;
      }
      if (body.access_token) {
        let user: GithubUser | null = null;
        try {
          user = await fetchGithubUser(oauthConfig(await loadClientSecret(env)), body.access_token);
        } catch {
          user = null; // identity is refreshed on next successful credential use
        }
        record = recordFromResponse(body as Omit<OauthTokenResponse, "access_token"> & { access_token: string }, user);
        await store!.set(record);
        lastError = null;
        invalidateGithubCredential();
        break;
      }
    }
    if (pendingFlow === flow) pendingFlow = null;
  }

  function cancelDeviceFlow(): void {
    if (pendingFlow) pendingFlow.cancelled = true;
    pendingFlow = null;
  }

  async function signout(): Promise<void> {
    cancelDeviceFlow();
    await ensureLoaded();
    await store!.delete();
    record = null;
    loaded = true;
    lastError = null;
    invalidateGithubCredential();
  }

  async function status(): Promise<GithubAuthStatus> {
    await ensureLoaded();
    // Lazy refresh: expired-or-near-expiry tokens get one refresh attempt here.
    if (record && (isExpired(record) || Date.parse(record.expires_at ?? "") - Date.now() <= REFRESH_MARGIN_MS)) {
      await getValidUserToken();
    }
    const base: GithubAuthStatus = { state: "signed_out", auth_source: authSource(), store: store?.kind ?? "file" };
    if (!clientId) return { ...base, state: "not_configured" };
    if (pendingFlow && pendingFlow.expiresAt > Date.now() && !pendingFlow.cancelled) {
      return { ...base, state: "pending", device: { user_code: pendingFlow.user_code, verification_uri: pendingFlow.verification_uri, expires_at: new Date(pendingFlow.expiresAt).toISOString(), interval: pendingFlow.interval } };
    }
    if (record && !isExpired(record)) return { ...base, state: "signed_in", user: record.user ?? undefined };
    if (record && isExpired(record)) return { ...base, state: "expired", user: record.user ?? undefined, ...(lastError ? { error: lastError } : {}) };
    if (lastError && (lastError.code === "network_error" || lastError.code === "refresh_failed")) {
      return { ...base, state: "error", error: lastError };
    }
    if (lastError) return { ...base, error: lastError };
    return base;
  }

  async function installations(): Promise<{ install_url: string; installations: GithubInstallation[] }> {
    const installUrl = `https://github.com/apps/${appSlug}/installations/new`;
    const token = await getValidUserToken();
    if (!token) return { install_url: installUrl, installations: [] };
    const response = await fetchImpl(`${apiBaseUrl}/user/installations`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "agent-forge/0.1.0" },
    });
    if (!response.ok) return { install_url: installUrl, installations: [] };
    const body = await response.json() as {
      installations?: Array<{
        id: number;
        app_slug?: string;
        account?: { login: string; avatar_url?: string | null; html_url?: string | null };
        repository_selection?: string;
        permissions?: Record<string, string>;
        html_url?: string;
      }>;
    };
    const installationsList = (body.installations ?? [])
      .filter((installation) => installation.app_slug === undefined || installation.app_slug === appSlug)
      .map((installation) => ({
        id: installation.id,
        account: { login: installation.account?.login ?? "unknown", avatar_url: installation.account?.avatar_url ?? null, html_url: installation.account?.html_url ?? null },
        repository_selection: installation.repository_selection ?? "unknown",
        permissions: installation.permissions ?? {},
        html_url: installation.html_url ?? `https://github.com/settings/installations/${installation.id}`,
      }));
    return { install_url: installUrl, installations: installationsList };
  }

  async function capabilities(repo: string): Promise<{
    auth_source: "user" | "shared" | "none";
    installed: boolean;
    permissions: Record<string, string>;
    can: { read_pulls: boolean; read_checks: boolean; read_contents: boolean; read_issues: boolean; read_actions: boolean };
  }> {
    const token = await getValidUserToken();
    if (token) {
      const { installations: list } = await installations();
      const owner = repo.split("/")[0]?.toLowerCase();
      const match = list.find((installation) => installation.account.login.toLowerCase() === owner);
      const permissions = match?.permissions ?? {};
      return { auth_source: "user", installed: Boolean(match), permissions, can: canFrom(permissions) };
    }
    if (sharedTokenAvailable()) {
      // ponytail: app installation is undetectable without app credentials (JWT); shared gh tokens are repo-scoped reads.
      return { auth_source: "shared", installed: false, permissions: {}, can: { read_pulls: true, read_checks: true, read_contents: true, read_issues: true, read_actions: true } };
    }
    return { auth_source: "none", installed: false, permissions: {}, can: { read_pulls: false, read_checks: false, read_contents: false, read_issues: false, read_actions: false } };
  }

  const service = {
    status,
    startDeviceFlow,
    cancelDeviceFlow,
    signout,
    installations,
    capabilities,
    getValidUserToken,
    get appSlug() { return appSlug; },
  };

  if (options.registerTokenProvider !== false) {
    setUserTokenProvider(() => getValidUserToken());
  }

  return service;
}

export type GithubAuthService = ReturnType<typeof buildGithubAuthService>;

function canFrom(permissions: Record<string, string>): { read_pulls: boolean; read_checks: boolean; read_contents: boolean; read_issues: boolean; read_actions: boolean } {
  const read = (key: string) => permissions[key] === "read" || permissions[key] === "write";
  return {
    read_pulls: read("pull_requests"),
    read_checks: read("checks") || read("statuses"),
    read_contents: read("contents"),
    read_issues: read("issues"),
    read_actions: read("actions"),
  };
}
