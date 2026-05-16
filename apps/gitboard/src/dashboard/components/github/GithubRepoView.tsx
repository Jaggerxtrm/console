// GithubRepoView (forge-5w9.8). Stacks ActivityTimeline / PrTimeline / IssueTimeline /
// ReleaseTimeline for a single repo, filtered from the github store. No tabs — sidebar
// is the nav. Sticky section headers per UX edit.

import { useMemo, useState } from "react";
import { useGithubStore } from "../../stores/github.ts";
import { ActivityTimeline } from "./ActivityTimeline.tsx";
import { PrTimeline } from "./PrTimeline.tsx";
import { IssueTimeline } from "./IssueTimeline.tsx";
import { ReleaseTimeline } from "./ReleaseTimeline.tsx";
import type { RepoNode } from "../../../types/shell.ts";
import type { GithubEvent } from "../../../types/github.ts";

export function GithubRepoView({ repo }: { repo: RepoNode }) {
  const events = useGithubStore((s) => s.events);
  const prs = useGithubStore((s) => s.prs);
  const issues = useGithubStore((s) => s.issues);
  const releases = useGithubStore((s) => s.releases);
  const loading = useGithubStore((s) => s.loading);
  const error = useGithubStore((s) => s.error);

  const filteredEvents = useMemo(
    () => events.filter((e) => e.repo === repo.fullName),
    [events, repo.fullName],
  );
  const filteredPrs = useMemo(
    () => prs.filter((p) => p.repo === repo.fullName),
    [prs, repo.fullName],
  );
  const filteredIssues = useMemo(
    () => issues.filter((i) => i.repo === repo.fullName),
    [issues, repo.fullName],
  );
  const filteredReleases = useMemo(
    () => releases.filter((r) => r.repo_full_name === repo.fullName),
    [releases, repo.fullName],
  );

  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const handleSelect = (e: GithubEvent) => setSelectedEventId(e.id);

  if (loading && events.length === 0) {
    return (
      <div className="shell-skeleton">
        {[0, 1, 2].map((i) => (
          <div key={i} className="shell-skeleton-col" style={{ minWidth: 200 }}>
            <div className="shell-skeleton-col-head" />
            <div className="shell-skeleton-card" />
            <div className="shell-skeleton-card" />
          </div>
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <div className="shell-error">
        <p className="shell-error-msg">{error}</p>
      </div>
    );
  }

  return (
    <div className="shell-github-view">
      <Section title="Recent activity" count={filteredEvents.length}>
        {filteredEvents.length > 0 ? (
          <ActivityTimeline
            events={filteredEvents}
            selectedId={selectedEventId}
            onSelect={handleSelect}
          />
        ) : (
          <EmptyRow label="No events recorded for this repo." />
        )}
      </Section>
      <Section title="Pull requests" count={filteredPrs.length}>
        {filteredPrs.length > 0 ? (
          <PrTimeline prs={filteredPrs} />
        ) : (
          <EmptyRow label="No pull requests recorded for this repo." />
        )}
      </Section>
      <Section title="Issues" count={filteredIssues.length}>
        {filteredIssues.length > 0 ? (
          <IssueTimeline issues={filteredIssues} />
        ) : (
          <EmptyRow label="No issues recorded for this repo." />
        )}
      </Section>
      <Section title="Releases" count={filteredReleases.length}>
        {filteredReleases.length > 0 ? (
          <ReleaseTimeline releases={filteredReleases} />
        ) : (
          <EmptyRow label="No releases recorded for this repo." />
        )}
      </Section>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="shell-github-section">
      <header className="shell-github-section-head">
        <span className="shell-section-title">{title}</span>
        <span className="shell-section-meta">{count}</span>
      </header>
      <div className="shell-github-section-body">{children}</div>
    </section>
  );
}

function EmptyRow({ label }: { label: string }) {
  return <p className="shell-github-empty">{label}</p>;
}
