// IDE shell layout contracts (forge-5w9).
// Aggregates per-repo github + beads stats for the file-tree sidebar.

export type RepoSection = "github" | "beads";

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
}
