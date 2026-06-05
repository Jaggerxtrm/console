import {
  GitCommitIcon,
  GitPullRequestIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  CodeReviewIcon,
  IssueOpenedIcon,
  IssueDraftIcon,
  TagIcon,
  GitBranchIcon,
  StarIcon,
  RepoForkedIcon,
} from "@primer/octicons-react";

const EVENT_STYLES: Record<string, { Icon: React.ComponentType<{ size?: number }>; color: string }> = {
  PushEvent: { Icon: GitCommitIcon, color: "#6366f1" },
  PullRequestEvent_opened: { Icon: GitPullRequestIcon, color: "#10b981" },
  PullRequestEvent_merged: { Icon: GitMergeIcon, color: "#8b5cf6" },
  PullRequestEvent_closed: { Icon: GitPullRequestClosedIcon, color: "rgba(244,63,94,0.6)" },
  PullRequestReviewEvent: { Icon: CodeReviewIcon, color: "#f59e0b" },
  IssuesEvent_opened: { Icon: IssueOpenedIcon, color: "#22c55e" },
  IssuesEvent_closed: { Icon: IssueDraftIcon, color: "#6b7280" },
  ReleaseEvent: { Icon: TagIcon, color: "#14b8a6" },
  CreateEvent: { Icon: GitBranchIcon, color: "#94a3b8" },
  WatchEvent: { Icon: StarIcon, color: "#78716c" },
  ForkEvent: { Icon: RepoForkedIcon, color: "#78716c" },
};

const DEFAULT_STYLE = { Icon: GitCommitIcon, color: "#6b7280" };

interface Props {
  type: string;
  action?: string | null;
}

export function EventIcon({ type, action }: Props) {
  const key = action ? `${type}_${action}` : type;
  const { Icon, color } = EVENT_STYLES[key] ?? EVENT_STYLES[type] ?? DEFAULT_STYLE;
  return <Icon size={16} />;
}

export function eventColor(type: string, action?: string | null): string {
  const key = action ? `${type}_${action}` : type;
  return EVENT_STYLES[key]?.color ?? EVENT_STYLES[type]?.color ?? DEFAULT_STYLE.color;
}
