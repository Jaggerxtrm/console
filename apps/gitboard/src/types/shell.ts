// IDE shell layout contracts (forge-5w9 / forge-7xu rebuild).
// Topbar = surface switch [github|beads] + tab strip for the current surface.
// Sidebar = single-level repo list. MainPane renders (surface, tab, repo).

export type Surface = "github" | "beads";

export type GithubTab =
  | "activity"
  | "prs"
  | "issues"
  | "releases"
  | "readme"
  | "changelog"
  | "reports";

export type BeadsTab = "feed" | "triage" | "memories";

export type TabId = GithubTab | BeadsTab;

export const GITHUB_TABS: { id: GithubTab; label: string }[] = [
  { id: "activity",  label: "Activity" },
  { id: "prs",       label: "Pull Requests" },
  { id: "issues",    label: "Issues" },
  { id: "releases",  label: "Releases" },
  { id: "readme",    label: "README" },
  { id: "changelog", label: "CHANGELOG" },
  { id: "reports",   label: "Reports" },
];

export const BEADS_TABS: { id: BeadsTab; label: string }[] = [
  { id: "feed",      label: "Feed" },
  { id: "triage",    label: "Triage" },
  { id: "memories",  label: "Memories" },
];

export const DEFAULT_TAB: Record<Surface, TabId> = {
  github: "activity",
  beads: "feed",
};

export interface GithubChips {
  openPRs: number;
  commitsToday: number;
  openIssues: number;
  releases: number;
}

export interface BeadsChips {
  open: number;
  inProgress: number;
  blocked: number;
  epics: number;
}

export interface RepoNode {
  fullName: string;
  displayName: string;
  groupName?: string | null;       // preserved for sidebar grouping (legacy parity)
  lastActivityAt: string | null;
  openBeadsCount: number;
  githubStats: GithubChips;
  beadsStats: BeadsChips;
  hasGithub: boolean;
  hasBeads: boolean;
}

export interface SidebarSelection {
  surface: Surface;
  tab: TabId;
  repo: string | null;             // RepoNode.fullName — null = no repo selected
}
