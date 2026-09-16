/** Shared (fallback) token provider: env GITHUB_TOKEN, else `gh auth token`. */

export type GithubAuthSource = "user" | "shared" | "none";
export type GithubCredential = { token: string | null; source: GithubAuthSource };
export type UserTokenProvider = () => Promise<string | null>;

let userTokenProvider: UserTokenProvider | null = null;

/**
 * Register the process-wide user-token provider (set by the GitHub auth
 * service). Last registration wins; tests can reset with null.
 */
export function setUserTokenProvider(provider: UserTokenProvider | null): void {
  userTokenProvider = provider;
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
 * (refreshed before expiry by the provider) -> GITHUB_TOKEN -> `gh auth token`.
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
  const shared = sharedGithubToken();
  return { token: shared, source: shared ? "shared" : "none" };
}

function sharedGithubToken(): string | null {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
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
