export function getGithubToken(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const result = Bun.spawnSync(["gh", "auth", "token"]);
  if (result.exitCode === 0) return result.stdout.toString().trim();
  throw new Error("No GitHub token found. Run `gh auth login` or set GITHUB_TOKEN.");
}

export async function getAuthenticatedUsername(token: string): Promise<string> {
  const response = await fetch("https://api.github.com/user", {
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
