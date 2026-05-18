import { useEffect, useCallback } from "react";
import { useGithubStore } from "../stores/github.ts";
import { apiClient } from "../lib/client.ts";
import { useWebSocket } from "./useWebSocket.ts";
import type { WsMessage } from "../lib/ws.ts";
import type { GithubEvent, GithubPr, GithubIssue } from "../../types/github.ts";

export function useGithubActivity(): void {
  const {
    filter,
    setEvents,
    appendEvents,
    prependEvent,
    setRepos,
    setContributions,
    setSummary,
    setRepoStats,
    markRepoUnread,
    setLoading,
    setError,
    setPrs,
    upsertPr,
    setIssues,
    upsertIssue,
    setReleases,
  } = useGithubStore();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [eventsRes, reposRes, contribRes, summaryRes, statsRes, prsRes, issuesRes] = await Promise.all([
        apiClient.getEvents({ ...filter, limit: 50, offset: 0 }),
        apiClient.getRepos(),
        apiClient.getContributions(),
        apiClient.getSummary("today"),
        apiClient.getRepoStats(),
        apiClient.getPrs({ limit: 1000 }),
        apiClient.getIssues({ limit: 100 }),
      ]);
      const releaseResponses = await Promise.all(
        reposRes.data.map((repo) => apiClient.getReleases({ repo: repo.full_name, limit: 100 })),
      );
      setEvents(eventsRes.data);
      setRepos(reposRes.data);
      setContributions(contribRes.data);
      setSummary(summaryRes);
      setRepoStats(statsRes.data);
      setPrs(prsRes.data);
      setIssues(issuesRes.data);
      setReleases(
        releaseResponses
          .flatMap((response) => response.releases)
          .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? "")),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, [filter, setEvents, setRepos, setContributions, setSummary, setRepoStats, setLoading, setError, setPrs, setIssues, setReleases]);

  useEffect(() => {
    void load();
  }, [load]);

  const wsHandler = useCallback(
    (msg: WsMessage) => {
      if (msg.event === "github:event.append" && msg.data) {
        const event = msg.data as GithubEvent;
        prependEvent(event);
        markRepoUnread(event.repo);
      }
      if (msg.event === "github:pr.upsert" && msg.data) {
        const pr = msg.data as GithubPr;
        upsertPr(pr);
        markRepoUnread(pr.repo);
      }
      if (msg.event === "github:issue.upsert" && msg.data) {
        const issue = msg.data as GithubIssue;
        upsertIssue(issue);
        markRepoUnread(issue.repo);
      }
      if (msg.event === "github:sync_hint" && msg.data && typeof msg.data === "object" && "repos" in (msg.data as Record<string, unknown>)) {
        void load();
      }
    },
    [prependEvent, markRepoUnread, upsertPr, upsertIssue, load]
  );

  useWebSocket("github:activity", wsHandler);

  const loadMore = useCallback(async () => {
    const currentCount = useGithubStore.getState().events.length;
    try {
      const res = await apiClient.getEvents({
        ...filter,
        limit: 50,
        offset: currentCount,
      });
      appendEvents(res.data);
    } catch {
      // ignore load-more errors
    }
  }, [filter, appendEvents]);

  // Expose loadMore via store would be cleaner, but for now attach to window for dev
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__loadMoreGithubEvents = loadMore;
  }, [loadMore]);
}
