import { describe, expect, it } from "vitest";
import duplicateAliases from "../../fixtures/repo-aliases-duplicate.json";
import { buildRepoNodes } from "../../../src/dashboard/hooks/useRepoTree.ts";
import type { BeadsProject, BeadsStats } from "../../../src/types/beads.ts";
import type { GithubRepo, RepoStat } from "../../../src/types/github.ts";

const project = (name: string, id = `${name}-id`): BeadsProject => ({
  id,
  name,
  path: `/tmp/${name}`,
  beadsPath: `/tmp/${name}/.beads`,
  issueCount: 0,
  lastScanned: "2026-01-01T00:00:00.000Z",
  status: "active",
});

const source = { label: "dolt" as const, title: "Dolt connected", healthy: true };

const repo = (fullName: string): GithubRepo => ({
  full_name: fullName,
  display_name: null,
  tracked: true,
  group_name: null,
  last_polled_at: null,
  color: null,
});

const stat = (fullName: string, over: Partial<RepoStat> = {}): RepoStat => ({
  full_name: fullName,
  pushes: 0,
  prs_open: 0,
  prs_closed: 0,
  issues_open: 0,
  releases: 0,
  last_event_at: null,
  ...over,
});

const beadsStats = (over: Partial<BeadsStats> = {}): BeadsStats => ({
  total: 0,
  open: 0,
  in_progress: 0,
  blocked: 0,
  closed: 0,
  last_activity_at: null,
  by_priority: {},
  by_type: {},
  ...over,
});

type BeadsSide = { project: BeadsProject; stats: BeadsStats | null; source: typeof source };
type AliasFixture = { project: string; projectId: string; matches: string[] };

function beadsMap(...entries: BeadsSide[]): Map<string, BeadsSide> {
  return new Map(entries.map((entry) => [entry.project.name, entry]));
}

const duplicateAliasFixture = duplicateAliases as AliasFixture[];

describe("buildRepoNodes alias canonicalization", () => {
  it("collapses old/new-owner aliases for one Beads project into a single row", () => {
    const nodes = buildRepoNodes(
      [repo("Jaggerxtrm/terminalbeta"), repo("mercuryintelligence/terminalbeta")],
      new Map([
        ["Jaggerxtrm/terminalbeta", stat("Jaggerxtrm/terminalbeta", { prs_open: 2 })],
        ["mercuryintelligence/terminalbeta", stat("mercuryintelligence/terminalbeta", { prs_open: 3 })],
      ]),
      beadsMap({ project: project("terminalbeta"), stats: beadsStats({ open: 4, in_progress: 1 }), source }),
    );

    expect(nodes).toHaveLength(1);
    const [node] = nodes;
    expect(node.hasGithub).toBe(true);
    expect(node.hasBeads).toBe(true);
    expect(node.beadsProjectId).toBe("terminalbeta-id");
    expect(node.openBeadsCount).toBe(5);
  });

  it("aggregates GitHub counts (sum) and last_event_at (max) across aliases", () => {
    const nodes = buildRepoNodes(
      [repo("Jaggerxtrm/terminalbeta"), repo("mercuryintelligence/terminalbeta")],
      new Map([
        ["Jaggerxtrm/terminalbeta", stat("Jaggerxtrm/terminalbeta", { prs_open: 2, issues_open: 1, pushes: 4, releases: 1, last_event_at: "2026-06-01T00:00:00.000Z" })],
        ["mercuryintelligence/terminalbeta", stat("mercuryintelligence/terminalbeta", { prs_open: 3, issues_open: 2, pushes: 5, releases: 0, last_event_at: "2026-07-01T00:00:00.000Z" })],
      ]),
      beadsMap({ project: project("terminalbeta"), stats: beadsStats({ last_activity_at: "2026-05-01T00:00:00.000Z" }), source }),
    );

    const [node] = nodes;
    expect(node.githubStats).toEqual({ openPRs: 5, commitsToday: 9, openIssues: 3, releases: 1 });
    expect(node.lastActivityAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("picks the alias whose tail matches the Beads project name as canonical fullName", () => {
    const nodes = buildRepoNodes(
      [
        repo("mercuryintelligence/mercury-quant"),
        repo("Jaggerxtrm/mercury-quant"),
        repo("goldmansachs/gs-quant"),
        repo("mercuryintelligence/quant"),
      ],
      new Map(),
      beadsMap({ project: project("quant"), stats: null, source }),
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0].fullName).toBe("mercuryintelligence/quant");
    expect(nodes[0].beadsProjectName).toBe("quant");
  });

  it("keeps distinct Beads projects as separate canonical rows", () => {
    const nodes = buildRepoNodes(
      [repo("mercuryintelligence/website"), repo("Jaggerxtrm/mercury-website"), repo("Jaggerxtrm/xtrm"), repo("xtrm-dev/xtrm")],
      new Map(),
      beadsMap(
        { project: project("website"), stats: null, source },
        { project: project("xtrm"), stats: null, source },
      ),
    );

    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.beadsProjectName).sort()).toEqual(["website", "xtrm"]);
    expect(nodes.find((n) => n.beadsProjectName === "website")?.fullName).toBe("mercuryintelligence/website");
    expect(nodes.find((n) => n.beadsProjectName === "xtrm")?.fullName).toBe("Jaggerxtrm/xtrm");
  });

  it("preserves Beads-only orphans and unmatched GitHub repos", () => {
    const nodes = buildRepoNodes(
      [repo("someorg/untracked-repo")],
      new Map([["someorg/untracked-repo", stat("someorg/untracked-repo", { prs_open: 7 })]]),
      beadsMap({ project: project("orphan-only"), stats: beadsStats({ open: 2, blocked: 1 }), source }),
    );

    expect(nodes).toHaveLength(2);
    const githubOnly = nodes.find((n) => n.fullName === "someorg/untracked-repo");
    const beadsOnly = nodes.find((n) => n.fullName === "orphan-only");
    expect(githubOnly?.hasGithub).toBe(true);
    expect(githubOnly?.hasBeads).toBe(false);
    expect(githubOnly?.githubStats.openPRs).toBe(7);
    expect(beadsOnly?.hasGithub).toBe(false);
    expect(beadsOnly?.hasBeads).toBe(true);
    expect(beadsOnly?.openBeadsCount).toBe(3);
  });

  it("is deterministic for the same inputs regardless of alias order", () => {
    const ordered = buildRepoNodes(
      [repo("mercuryintelligence/quant"), repo("goldmansachs/gs-quant"), repo("Jaggerxtrm/mercury-quant")],
      new Map(),
      beadsMap({ project: project("quant"), stats: null, source }),
    );
    const reversed = buildRepoNodes(
      [repo("Jaggerxtrm/mercury-quant"), repo("goldmansachs/gs-quant"), repo("mercuryintelligence/quant")],
      new Map(),
      beadsMap({ project: project("quant"), stats: null, source }),
    );

    expect(ordered[0].fullName).toBe(reversed[0].fullName);
    expect(ordered[0].fullName).toBe("mercuryintelligence/quant");
  });

  it("collapses fixture-backed alias groups without losing Beads counts or health", () => {
    const repos = duplicateAliasFixture.flatMap((entry) => entry.matches.map((fullName) => repo(fullName)));
    const repoStats = new Map(
      duplicateAliasFixture.flatMap((entry, entryIndex) =>
        entry.matches.map((fullName, matchIndex) => [
          fullName,
          stat(fullName, {
            prs_open: entryIndex + matchIndex + 1,
            pushes: matchIndex + 1,
            issues_open: entryIndex,
            releases: matchIndex % 2,
            last_event_at: `2026-07-${String((entryIndex % 9) + matchIndex + 1).padStart(2, "0")}T00:00:00.000Z`,
          }),
        ]),
      ),
    );
    const beadsSides = beadsMap(
      ...duplicateAliasFixture.map((entry, entryIndex) => ({
        project: project(entry.project, entry.projectId),
        stats: beadsStats({
          open: entryIndex + 1,
          in_progress: entry.matches.length,
          blocked: entryIndex % 2,
          last_activity_at: `2026-06-${String(entryIndex + 1).padStart(2, "0")}T00:00:00.000Z`,
        }),
        source: { ...source, healthy: entry.project !== "market-data" },
      })),
    );

    const nodes = buildRepoNodes(repos, repoStats, beadsSides);

    expect(nodes).toHaveLength(duplicateAliasFixture.length);
    for (const entry of duplicateAliasFixture) {
      const node = nodes.find((candidate) => candidate.beadsProjectName === entry.project);
      expect(node, `missing canonical row for ${entry.project}`).toBeTruthy();
      expect(node?.hasGithub).toBe(true);
      expect(node?.hasBeads).toBe(true);
      expect(node?.beadsProjectId).toBe(entry.projectId);
      expect(node?.beadsSource?.label).toBe("dolt");
      expect(node?.beadsSource?.healthy).toBe(entry.project !== "market-data");
      expect(node?.openBeadsCount).toBe((duplicateAliasFixture.findIndex((candidate) => candidate.project === entry.project) + 1) + entry.matches.length + (duplicateAliasFixture.findIndex((candidate) => candidate.project === entry.project) % 2));
      expect(nodes.filter((candidate) => candidate.beadsProjectName === entry.project)).toHaveLength(1);
    }

    const terminalbeta = nodes.find((node) => node.beadsProjectName === "terminalbeta");
    const website = nodes.find((node) => node.beadsProjectName === "website");
    const marketData = nodes.find((node) => node.beadsProjectName === "market-data");
    const specialists = nodes.find((node) => node.beadsProjectName === "specialists");
    const xtrm = nodes.find((node) => node.beadsProjectName === "xtrm");

    expect(terminalbeta?.githubStats.openPRs).toBe(3);
    expect(website?.githubStats.openPRs).toBe(9);
    expect(marketData?.githubStats.openPRs).toBe(18);
    expect(marketData?.beadsSource?.healthy).toBe(false);
    expect(specialists?.openBeadsCount).toBe(11);
    expect(xtrm?.githubStats.commitsToday).toBe(3);
  });
});
