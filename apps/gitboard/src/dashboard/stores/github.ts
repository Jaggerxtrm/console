import { create } from "zustand";
import type {
  GithubEvent,
  GithubCommit,
  GithubRepo,
  ContributionDay,
  Summary,
  EventFilter,
  RepoStat,
  GithubPr,
  GithubIssue,
  GithubRelease,
} from "../../types/github.ts";

export interface GithubState {
  events: GithubEvent[];
  selectedEvent: GithubEvent | null;
  selectedEventCommits: GithubCommit[];
  repos: GithubRepo[];
  contributions: ContributionDay[];
  summary: Summary | null;
  filter: EventFilter;
  loading: boolean;
  error: string | null;
  repoStats: Record<string, RepoStat>;
  unreadRepos: Set<string>;
  prs: GithubPr[];
  issues: GithubIssue[];
  releases: GithubRelease[];

  setEvents: (events: GithubEvent[]) => void;
  appendEvents: (events: GithubEvent[]) => void;
  prependEvent: (event: GithubEvent | null) => void;
  selectEvent: (event: GithubEvent | null) => void;
  setSelectedEventCommits: (commits: GithubCommit[]) => void;
  setRepos: (repos: GithubRepo[]) => void;
  updateRepo: (full_name: string, updates: Partial<GithubRepo>) => void;
  setContributions: (contributions: ContributionDay[]) => void;
  setSummary: (summary: Summary) => void;
  setFilter: (filter: Partial<EventFilter>) => void;
  resetFilter: () => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setRepoStats: (stats: RepoStat[]) => void;
  markRepoUnread: (fullName: string) => void;
  clearRepoUnread: (fullName: string) => void;
  setPrs: (prs: GithubPr[]) => void;
  clearPrs: () => void;
  upsertPr: (pr: GithubPr) => void;
  setIssues: (issues: GithubIssue[]) => void;
  clearIssues: () => void;
  upsertIssue: (issue: GithubIssue) => void;
  setReleases: (releases: GithubRelease[]) => void;
  clearReleases: () => void;
}

const defaultFilter: EventFilter = {};

export const useGithubStore = create<GithubState>((set) => ({
  events: [],
  selectedEvent: null,
  selectedEventCommits: [],
  repos: [],
  contributions: [],
  summary: null,
  filter: defaultFilter,
  loading: false,
  error: null,
  repoStats: {},
  unreadRepos: new Set(),
  prs: [],
  issues: [],
  releases: [],

  setEvents: (events) => set({ events }),

  appendEvents: (events) =>
    set((s) => {
      const existingIds = new Set(s.events.map((e) => e.id));
      const newEvents = events.filter((e) => !existingIds.has(e.id));
      return { events: [...s.events, ...newEvents] };
    }),

  prependEvent: (event) =>
    set((s) => {
      if (!event || s.events.some((e) => e.id === event.id)) return s;
      return { events: [event, ...s.events] };
    }),

  selectEvent: (event) => set({ selectedEvent: event, selectedEventCommits: [] }),

  setSelectedEventCommits: (commits) => set({ selectedEventCommits: commits }),

  setRepos: (repos) => set({ repos }),

  updateRepo: (full_name, updates) =>
    set((s) => ({
      repos: s.repos.map((r) =>
        r.full_name === full_name ? { ...r, ...updates } : r
      ),
    })),

  setContributions: (contributions) => set({ contributions }),

  setSummary: (summary) => set({ summary }),

  setFilter: (filter) =>
    set((s) => ({ filter: { ...s.filter, ...filter } })),

  resetFilter: () => set({ filter: defaultFilter }),

  setLoading: (loading) => set({ loading }),

  setError: (error) => set({ error }),

  setRepoStats: (stats) => set({
    repoStats: Object.fromEntries(stats.map(s => [s.full_name, s]))
  }),

  markRepoUnread: (fullName) => set(s => ({
    unreadRepos: new Set([...s.unreadRepos, fullName])
  })),

  clearRepoUnread: (fullName) => set(s => {
    const next = new Set(s.unreadRepos);
    next.delete(fullName);
    return { unreadRepos: next };
  }),

  setPrs: (prs) => set((s) => (prs.length === 0 && s.prs.length > 0 ? s : { prs })),

  clearPrs: () => set({ prs: [] }),

  upsertPr: (pr) => set((s) => ({
    prs: [pr, ...s.prs.filter((item) => !(item.repo === pr.repo && item.number === pr.number))].sort((a, b) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at)),
  })),

  setIssues: (issues) => set((s) => (issues.length === 0 && s.issues.length > 0 ? s : { issues })),

  clearIssues: () => set({ issues: [] }),

  upsertIssue: (issue) => set((s) => ({
    issues: [issue, ...s.issues.filter((item) => !(item.repo === issue.repo && item.number === issue.number))].sort((a, b) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at)),
  })),

  setReleases: (releases) => set((s) => (releases.length === 0 && s.releases.length > 0 ? s : { releases })),

  clearReleases: () => set({ releases: [] }),
}));
