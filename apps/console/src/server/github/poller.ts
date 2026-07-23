import {
  GithubPoller as CoreGithubPoller,
  getAuthenticatedUsername,
  getGithubToken,
  transformCommits,
  transformEvent,
  type GithubActivityPublisher,
  type GithubPollerOptions as CoreGithubPollerOptions,
  type RawGithubCommit,
  type RawGithubEvent,
} from "../../../../../packages/core/src/github/index.ts";

export { getAuthenticatedUsername, getGithubToken, transformCommits, transformEvent };
export type { GithubActivityPublisher, RawGithubCommit, RawGithubEvent };
export type GithubPollerDatabase = ConstructorParameters<typeof CoreGithubPoller>[0];
export type GithubPollerOptions = CoreGithubPollerOptions;

export class GithubPoller extends CoreGithubPoller {
  constructor(db: GithubPollerDatabase, token: string, options: GithubPollerOptions = {}) {
    super(db, token, options);
  }
}

export function createGithubPoller(
  db: GithubPollerDatabase,
  token: string,
  options: GithubPollerOptions = {},
): GithubPoller {
  return new GithubPoller(db, token, options);
}
