import { REALTIME_PROTOCOL_VERSION } from "../types/realtime.ts";
import { emit, makeLogEntry } from "./logger.ts";
import type { ChannelName, ChannelRegistry } from "../api/ws/channels.ts";
import {
  GithubPoller as CoreGithubPoller,
  type GithubActivityPublisher,
  type GithubAdapterEventName,
  type GithubAdapterLogger,
  type GithubPollerOptions as CoreGithubPollerOptions,
  type RawGithubCommit,
  type RawGithubEvent,
  getAuthenticatedUsername,
  getGithubToken,
  transformCommits,
  transformEvent,
} from "../../../../packages/core/src/github/index.ts";

export {
  getAuthenticatedUsername,
  getGithubToken,
  transformCommits,
  transformEvent,
};

export type { RawGithubCommit, RawGithubEvent };

function buildAppActivityPublisher(registry: ChannelRegistry): GithubActivityPublisher {
  return {
    publish(channel, event: GithubAdapterEventName, data: unknown, version: string): void {
      registry.publish(channel as ChannelName, event, data, version ?? REALTIME_PROTOCOL_VERSION);
    },
  };
}

const appLogger: GithubAdapterLogger = {
  emit(entry) {
    const component = entry.component === "github" ? "poller" : entry.component;
    emit(makeLogEntry(component as Parameters<typeof makeLogEntry>[0], entry.event, entry.level, entry.msg, entry.data));
  },
};

export type GithubPollerDatabase = ConstructorParameters<typeof CoreGithubPoller>[0];

export interface GithubPollerShimOptions {
  intervalMs?: number;
  backfillPages?: number;
  repoConcurrency?: number;
  registry?: ChannelRegistry | null;
  protocolVersion?: string;
}

export class GithubPoller extends CoreGithubPoller {
  constructor(db: GithubPollerDatabase, token: string, options: GithubPollerShimOptions = {}) {
    const coreOptions: CoreGithubPollerOptions = {
      intervalMs: options.intervalMs,
      backfillPages: options.backfillPages,
      repoConcurrency: options.repoConcurrency,
      protocolVersion: options.protocolVersion,
      logger: appLogger,
    };
    if (options.registry) {
      coreOptions.registry = buildAppActivityPublisher(options.registry);
    }
    super(db, token, coreOptions);
  }
}

export function createGithubPoller(
  db: GithubPollerDatabase,
  token: string,
  options: GithubPollerShimOptions = {},
): GithubPoller {
  return new GithubPoller(db, token, options);
}
