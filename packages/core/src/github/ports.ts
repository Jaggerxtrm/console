export type GithubAdapterLogLevel = "debug" | "info" | "warn" | "error";
export type GithubAdapterLogComponent = "poller" | "github" | "api";

export interface GithubAdapterLogEntry {
  ts: string;
  level: GithubAdapterLogLevel;
  component: GithubAdapterLogComponent;
  event: string;
  msg?: string;
  data?: Record<string, unknown>;
}

export type GithubAdapterEventName =
  | "github:pr.upsert"
  | "github:issue.upsert"
  | "github:event.append"
  | "github:release.upsert"
  | "github:sync_hint"
  | "github:source_health";

export type GithubAdapterChannelName = "github:activity" | `github:repo:${string}`;

export interface GithubActivityPublisher {
  publish(channel: GithubAdapterChannelName, event: GithubAdapterEventName, data: unknown, version: string): void;
}

export interface GithubAdapterLogger {
  emit(entry: GithubAdapterLogEntry): void;
}

export function makeGithubAdapterLogEntry(
  component: GithubAdapterLogComponent,
  event: string,
  level: GithubAdapterLogLevel,
  msg?: string,
  data?: Record<string, unknown>,
): GithubAdapterLogEntry {
  return { ts: new Date().toISOString(), level, component, event, msg, data };
}

export const NOOP_GITHUB_ACTIVITY_PUBLISHER: GithubActivityPublisher = {
  publish() {
    // no-op publisher for isolated tests and disabled poller modes
  },
};

export const NOOP_GITHUB_ADAPTER_LOGGER: GithubAdapterLogger = {
  emit() {
    // no-op logger for isolated tests and disabled poller modes
  },
};
