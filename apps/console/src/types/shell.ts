// IDE shell layout contracts (forge-5w9 / forge-7xu rebuild).
// Topbar = surface switch [github|console] + tab strip for current surface.
// Sidebar = single-level repo list. MainPane renders (surface, tab, repo).

export type Surface = "github" | "console";
export type ThemeMode = "dark" | "light";
export type DrawerTab = "logs" | "specialists" | "terminal";
export type SpecialistsScope = "repo" | "all-hosts";

export type GithubTab =
  | "activity"
  | "prs"
  | "issues"
  | "releases"
  | "readme"
  | "changelog"
  | "reports";

export type BeadsTab = "feed" | "triage" | "memories";
export type ConsoleTab = "feed" | "triage" | "memories" | "graph" | "observability" | "specialists" | "operations" | "explore";

export type TabId = GithubTab | ConsoleTab;

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
  { id: "feed",      label: "Issues" },
  { id: "triage",    label: "Triage" },
  { id: "memories",  label: "Memories" },
];

export const CONSOLE_TABS: { id: ConsoleTab; label: string }[] = [
  { id: "feed",          label: "Issues" },
  { id: "graph",         label: "Graph" },
  { id: "specialists",   label: "Specialists" },
  { id: "operations",    label: "Operations" },
  { id: "explore",       label: "Explore" },
  { id: "observability", label: "Observability" },
  { id: "triage",        label: "Triage" },
  { id: "memories",      label: "Memories" },
];

export const DEFAULT_TAB: Record<Surface, TabId> = {
  github: "activity",
  console: "feed",
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

export interface BeadsSourceChip {
  label: "dolt" | "sqlite" | "jsonl" | "missing" | "error" | "unknown";
  title: string;
  healthy: boolean;
}

export interface RepoNode {
  fullName: string;
  displayName: string;
  groupName?: string | null;       // preserved for sidebar grouping (legacy parity)
  lastActivityAt: string | null;
  openBeadsCount: number;
  githubStats: GithubChips;
  beadsStats: BeadsChips;
  beadsSource: BeadsSourceChip | null;
  beadsProjectId?: string | null;
  beadsProjectName?: string | null;
  hasGithub: boolean;
  hasBeads: boolean;
}

export interface SidebarSelection {
  surface: Surface;
  tab: TabId;
  repo: string | null;             // RepoNode.fullName — null = no repo selected
}
