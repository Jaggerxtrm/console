// IDE shell layout contracts (forge-5w9 / forge-7xu rebuild).
// Topbar = surface switch [github|console] + tab strip for current surface.
// Sidebar = single-level repo list. MainPane renders (surface, tab, repo).

export type Surface = "github" | "console";
export type ThemeMode = "dark" | "light";

export type GithubTab =
  | "activity"
  | "prs"
  | "issues"
  | "releases"
  | "readme"
  | "changelog"
  | "reports";

export type BeadsTab = "feed" | "triage" | "memories";
export type ConsoleTab = "feed" | "triage" | "memories" | "graph" | "observability" | "specialists";

export type TabId = GithubTab | BeadsTab | ConsoleTab;

export const GITHUB_TABS: { id: GithubTab; label: string }[] = [
  { id: "activity", label: "Activity" },
  { id: "prs", label: "Pull Requests" },
  { id: "issues", label: "Issues" },
  { id: "releases", label: "Releases" },
  { id: "readme", label: "README" },
  { id: "changelog", label: "CHANGELOG" },
  { id: "reports", label: "Reports" },
];

export const BEADS_TABS: { id: BeadsTab; label: string }[] = [
  { id: "feed", label: "Feed" },
  { id: "triage", label: "Triage" },
  { id: "memories", label: "Memories" },
];

export const CONSOLE_TABS: { id: ConsoleTab; label: string }[] = [
  { id: "feed", label: "Feed" },
  { id: "triage", label: "Triage" },
  { id: "memories", label: "Memories" },
  { id: "graph", label: "Graph" },
  { id: "observability", label: "Observability" },
  { id: "specialists", label: "Specialists" },
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

export interface RepoNode {
  fullName: string;
  displayName: string;
  groupName?: string | null;
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
  repo: string | null;
}
