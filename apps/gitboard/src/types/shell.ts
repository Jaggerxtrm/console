// IDE shell layout contracts (forge-5w9).
// Aggregates per-repo github + beads stats for the file-tree sidebar.

export type RepoSection = "github" | "beads";

// Third-level leaves — each leaf is its own MainPane view with full content.
export type GithubLeaf = "activity" | "prs" | "issues" | "releases";
export type BeadsLeaf = "kanban" | "issues";
export type LeafId = GithubLeaf | BeadsLeaf;

export const GITHUB_LEAVES: { id: GithubLeaf; label: string }[] = [
  { id: "activity", label: "activity" },
  { id: "prs", label: "pull-requests" },
  { id: "issues", label: "issues" },
  { id: "releases", label: "releases" },
];

export const BEADS_LEAVES: { id: BeadsLeaf; label: string }[] = [
  { id: "kanban", label: "kanban" },
  { id: "issues", label: "issues" },
];

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
  fullName: string;           // canonical aggregation key, e.g. "owner/repo"
  displayName: string;
  lastActivityAt: string | null;
  openBeadsCount: number;
  githubStats: GithubChips;
  beadsStats: BeadsChips;
  hasGithub: boolean;         // repo present in github source
  hasBeads: boolean;          // repo present in beads source
}

export interface SidebarSelection {
  repo: string;               // RepoNode.fullName
  section: RepoSection;
  leaf: LeafId;               // which view inside the section
}
