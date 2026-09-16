/** Shared (fallback) token provider: env GITHUB_TOKEN, else `gh auth token`. */

export type GithubAuthSource = "user" | "shared" | "none";
export type GithubCredential = { token: string | null; source: GithubAuthSource };
export type UserTokenProvider = () => Promise<string | null>;

let userTokenProvider: UserTokenProvider | null = null;
/** Cached `gh auth token` result: subprocess resolution happens once per generation. */
let cachedGhToken: string | null | undefined;

/**
 * Register the process-wide user-token provider (set by the GitHub auth
 * service). Last registration wins; tests can reset with null.
 * Resets the shared-credential cache so the next resolution is fresh.
 */
export function setUserTokenProvider(provider: UserTokenProvider | null): void {
  userTokenProvider = provider;
  invalidateGithubCredential();
}

/**
 * Drop the cached shared credential. Called by the auth service on
 * sign-in, sign-out, and refresh so the next resolution re-reads state.
 */
export function invalidateGithubCredential(): void {
  cachedGhToken = undefined;
}

export function getGithubToken(): string {
  const credential = sharedGithubToken();
  if (credential) return credential;
  throw new Error("No GitHub token found. Run `gh auth login` or set GITHUB_TOKEN.");
}

/** True when a shared credential is available without the signed-in user token. */
export function hasSharedToken(): boolean {
  return sharedGithubToken() !== null;
}

/**
 * Credential resolution order for GitHub API calls: signed-in user token
 * (live provider read, so refresh-before-expiry is never bypassed) ->
 * GITHUB_TOKEN (fresh env read) -> `gh auth token` (cached subprocess).
 */
export async function resolveGithubCredential(): Promise<GithubCredential> {
  if (userTokenProvider) {
    try {
      const token = await userTokenProvider();
      if (token) return { token, source: "user" };
    } catch {
      // provider failures fall back to the shared credential
    }
  }
  if (process.env.GITHUB_TOKEN) return { token: process.env.GITHUB_TOKEN, source: "shared" };
  // ponytail: env lookup is free, subprocess is not — cache only the subprocess.
  if (cachedGhToken === undefined) cachedGhToken = ghAuthToken();
  return { token: cachedGhToken, source: cachedGhToken ? "shared" : "none" };
}

function sharedGithubToken(): string | null {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (cachedGhToken === undefined) cachedGhToken = ghAuthToken();
  return cachedGhToken;
}

function ghAuthToken(): string | null {
  try {
    const result = Bun.spawnSync(["gh", "auth", "token"]);
    if (result.exitCode === 0) return result.stdout.toString().trim() || null;
  } catch {
    // gh CLI unavailable
  }
  return null;
}

export async function getAuthenticatedUsername(token: string): Promise<string> {
  const response = await fetch(`${githubApiBaseUrl()}/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "agent-forge/0.1.0",
    },
  });
  if (!response.ok) throw new Error(`GitHub API error ${response.status}: /user`);
  const user = await response.json() as { login: string };
  return user.login;
}

export function githubApiBaseUrl(): string {
  return process.env.XTRM_GITHUB_API_BASE_URL ?? "https://api.github.com";
}
