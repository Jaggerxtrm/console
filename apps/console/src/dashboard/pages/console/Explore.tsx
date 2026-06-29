import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Datasource, ExplorePanelKind } from "../../../../../../packages/core/src/explore/index.ts";
import { PulseIcon, SearchIcon, ServerIcon } from "@primer/octicons-react";
import { logClientEvent } from "../../lib/client-log.ts";

type ExploreTab = ExplorePanelKind;
type RangeFilter = "7d" | "30d" | "all";

type AgentopsPayload = {
  filters: { range: RangeFilter; repoSlug: string | null; specialist: string | null; model: string | null; status: string | null };
  summary: { totalJobs: number; activeJobs: number; doneJobs: number; errorJobs: number; tokenTotal: number; turnsTotal: number; toolsTotal: number };
  facets: {
    repoSlugs: Facet[];
    specialists: Facet[];
    models: Facet[];
    statuses: Facet[];
  };
  statusBreakdown: Array<{ status: string; count: number }>;
  specialistLeaderboard: Array<{ specialist: string; jobs: number; tokenTotal: number; turnsTotal: number; toolsTotal: number }>;
  modelLeaderboard: Array<{ model: string; jobs: number; tokenTotal: number; turnsTotal: number; toolsTotal: number }>;
  recentJobs: AgentopsJob[];
  slowestJobs: AgentopsJob[];
  source_health: { source: string; status: string; metadata?: Record<string, unknown> };
};

type Facet = { value: string; count: number };

type AgentopsJob = {
  jobId: string;
  beadId: string;
  repoSlug: string;
  specialist: string;
  status: string;
  model: string;
  updatedAtMs: number;
  elapsedMs: number;
  tokenTotal: number;
  turns: number;
  tools: number;
};

const FOLLOW_UPS: Record<Exclude<ExploreTab, "agentops">, { title: string; bead: string; text: string }> = {
  forensic: {
    title: "Forensic explorer",
    bead: "forge-l5mf",
    text: "Native xtrm.forensic.v1 event exploration lands in the follow-up epic.",
  },
  prom: {
    title: "PromQL explorer",
    bead: "forge-qixi",
    text: "Prometheus query mode stays separate from this AgentOps tranche.",
  },
};

const DATASOURCES: Datasource[] = [
  {
    id: "agentops",
    kind: "agentops",
    label: "AgentOps native",
    mount: () => ({
      id: "agentops",
      kind: "agentops",
      title: "AgentOps",
      mount: "native",
      component: "agentops-explorer",
    }),
  },
  {
    id: "forensic-events",
    kind: "forensic",
    label: "Forensic events",
    mount: () => ({
      id: "forensic",
      kind: "forensic",
      title: "Forensic",
      mount: "native",
      component: "coming-soon",
    }),
  },
  {
    id: "prometheus",
    kind: "prom",
    label: "Prometheus",
    mount: () => ({
      id: "prom",
      kind: "prom",
      title: "Prometheus",
      mount: "native",
      component: "coming-soon",
    }),
  },
];

const EMPTY: AgentopsPayload = {
  filters: { range: "7d", repoSlug: null, specialist: null, model: null, status: null },
  summary: { totalJobs: 0, activeJobs: 0, doneJobs: 0, errorJobs: 0, tokenTotal: 0, turnsTotal: 0, toolsTotal: 0 },
  facets: { repoSlugs: [], specialists: [], models: [], statuses: [] },
  statusBreakdown: [],
  specialistLeaderboard: [],
  modelLeaderboard: [],
  recentJobs: [],
  slowestJobs: [],
  source_health: { source: "explore-agentops", status: "unknown", metadata: {} },
};

export function Explore() {
  const legacySqlPath = window.location.pathname.includes("/console/explore/sql");
  const [active, setActive] = useState<ExploreTab>(() => tabFromPath(window.location.pathname));
  const datasource = useMemo(() => DATASOURCES.find((item) => item.kind === active) ?? DATASOURCES[0], [active]);
  const mount = datasource.mount();

  useEffect(() => {
    logClientEvent("route_loaded", { component: "explore", tab: active });
  }, [active]);

  const setTab = (tab: ExploreTab) => {
    setActive(tab);
    window.history.pushState({}, "", `/console/explore/${tab}`);
  };

  return (
    <section className="explore-page">
      <header className="explore-header">
        <div>
          <span className="explore-eyebrow">Native datasource</span>
          <h1>Explore</h1>
        </div>
        <span className="explore-active-source">{datasource.label}</span>
      </header>

      <nav className="explore-tabs" role="tablist" aria-label="Explore datasources">
        <ExploreTabButton tab="agentops" active={active === "agentops"} onSelect={setTab} />
        <ExploreTabButton tab="forensic" active={active === "forensic"} onSelect={setTab} />
        <ExploreTabButton tab="prom" active={active === "prom"} onSelect={setTab} />
      </nav>

      <div className="explore-panel">
        {mount.kind === "agentops" ? <AgentopsExplorer legacySqlPath={legacySqlPath} /> : <ComingSoon tab={mount.kind} />}
      </div>
    </section>
  );
}

function AgentopsExplorer({ legacySqlPath }: { legacySqlPath: boolean }) {
  const [range, setRange] = useState<RangeFilter>("7d");
  const [repoSlug, setRepoSlug] = useState("");
  const [specialist, setSpecialist] = useState("");
  const [model, setModel] = useState("");
  const [status, setStatus] = useState("");
  const [data, setData] = useState<AgentopsPayload>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadedOnce = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ range });
    if (repoSlug) params.set("repo_slug", repoSlug);
    if (specialist) params.set("specialist", specialist);
    if (model) params.set("model", model);
    if (status) params.set("status", status);
    setLoading(true);
    fetch(`/api/console/explore/agentops?${params.toString()}`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`AgentOps API ${res.status}`);
        return res.json() as Promise<AgentopsPayload>;
      })
      .then((payload) => {
        setData(payload);
        setError(null);
        if (!loadedOnce.current) {
          loadedOnce.current = true;
          logClientEvent("explore_agentops_loaded", {
            component: "explore",
            total_jobs: payload.summary.totalJobs,
            source_status: payload.source_health.status,
          });
        }
      })
      .catch((err: unknown) => {
        if ((err as Error).name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load AgentOps explore data");
        setData(EMPTY);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [range, repoSlug, specialist, model, status]);

  const handleFilter = (filter: "range" | "repo_slug" | "specialist" | "model" | "status", value: string) => {
    if (filter === "range") setRange(value as RangeFilter);
    if (filter === "repo_slug") setRepoSlug(value);
    if (filter === "specialist") setSpecialist(value);
    if (filter === "model") setModel(value);
    if (filter === "status") setStatus(value);
    logClientEvent("explore_filter_changed", { component: "explore", filter, value_hash: value ? shortHash(value) : null });
  };

  return (
    <div className="explore-agentops">
      {legacySqlPath ? <div className="explore-debug-note">SQL debug moved out of primary flow. Native AgentOps is now the default Explore surface.</div> : null}
      <div className="explore-filterbar">
        <Select label="Range" value={range} onChange={(value) => handleFilter("range", value)} options={[{ value: "7d", count: 0 }, { value: "30d", count: 0 }, { value: "all", count: 0 }]} />
        <Select label="Repo" value={repoSlug} onChange={(value) => handleFilter("repo_slug", value)} options={data.facets.repoSlugs} />
        <Select label="Specialist" value={specialist} onChange={(value) => handleFilter("specialist", value)} options={data.facets.specialists} />
        <Select label="Model" value={model} onChange={(value) => handleFilter("model", value)} options={data.facets.models} />
        <Select label="Status" value={status} onChange={(value) => handleFilter("status", value)} options={data.facets.statuses} />
      </div>

      {error ? <div className="explore-error" role="status">{error}</div> : null}
      {loading ? <div className="explore-loading" role="status">Loading AgentOps data...</div> : null}

      <section className="explore-stat-strip" aria-label="AgentOps summary">
        <Stat label="Jobs" value={`${formatNumber(data.summary.totalJobs)} jobs`} />
        <Stat label="Active" value={formatNumber(data.summary.activeJobs)} />
        <Stat label="Errors" value={formatNumber(data.summary.errorJobs)} tone={data.summary.errorJobs > 0 ? "bad" : "normal"} />
        <Stat label="Tokens" value={formatNumber(data.summary.tokenTotal)} />
        <Stat label="Turns" value={formatNumber(data.summary.turnsTotal)} />
        <Stat label="Tools" value={formatNumber(data.summary.toolsTotal)} />
      </section>

      <div className="explore-grid">
        <Panel title="Status distribution">
          <BarList rows={data.statusBreakdown.map((row) => ({ label: row.status, value: row.count }))} />
        </Panel>
        <Panel title="Specialist leaderboard">
          <Leaderboard rows={data.specialistLeaderboard.map((row) => ({ label: row.specialist, jobs: row.jobs, tokenTotal: row.tokenTotal, turnsTotal: row.turnsTotal, toolsTotal: row.toolsTotal }))} />
        </Panel>
        <Panel title="Model leaderboard">
          <Leaderboard rows={data.modelLeaderboard.map((row) => ({ label: row.model, jobs: row.jobs, tokenTotal: row.tokenTotal, turnsTotal: row.turnsTotal, toolsTotal: row.toolsTotal }))} />
        </Panel>
        <Panel title="Slowest jobs">
          <JobTable jobs={data.slowestJobs} metric="elapsed" />
        </Panel>
        <Panel title="Recent jobs">
          <JobTable jobs={data.recentJobs} metric="updated" />
        </Panel>
      </div>
    </div>
  );
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: Facet[]; onChange: (value: string) => void }) {
  return (
    <label className="explore-filter">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.currentTarget.value)} aria-label={label}>
        <option value="">All</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.count ? `${option.value} (${option.count})` : option.value}</option>
        ))}
      </select>
    </label>
  );
}

function Stat({ label, value, tone = "normal" }: { label: string; value: string; tone?: "normal" | "bad" }) {
  return (
    <div className={tone === "bad" ? "explore-stat is-bad" : "explore-stat"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="explore-native-panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function BarList({ rows }: { rows: Array<{ label: string; value: number }> }) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  if (rows.length === 0) return <EmptyPanel />;
  return (
    <div className="explore-bars">
      {rows.map((row) => (
        <div className="explore-bar-row" key={row.label}>
          <span>{row.label}</span>
          <div><i style={{ width: `${Math.max(3, (row.value / max) * 100)}%` }} /></div>
          <b>{formatNumber(row.value)}</b>
        </div>
      ))}
    </div>
  );
}

function Leaderboard({ rows }: { rows: Array<{ label: string; jobs: number; tokenTotal: number; turnsTotal: number; toolsTotal: number }> }) {
  if (rows.length === 0) return <EmptyPanel />;
  return (
    <div className="explore-leaderboard">
      {rows.map((row) => (
        <div className="explore-leader-row" key={row.label}>
          <span>{row.label}</span>
          <b>{formatNumber(row.tokenTotal)}</b>
          <small>{row.jobs} jobs / {row.turnsTotal} turns / {row.toolsTotal} tools</small>
        </div>
      ))}
    </div>
  );
}

function JobTable({ jobs, metric }: { jobs: AgentopsJob[]; metric: "elapsed" | "updated" }) {
  if (jobs.length === 0) return <EmptyPanel />;
  return (
    <div className="explore-job-table">
      <div className="explore-job-row is-header">
        <span>Job</span>
        <span>Specialist</span>
        <span>Status</span>
        <span>{metric === "elapsed" ? "Elapsed" : "Updated"}</span>
      </div>
      {jobs.map((job) => (
        <a
          className="explore-job-row"
          href={`/console/specialists?job=${encodeURIComponent(job.jobId)}${job.beadId ? `&bead=${encodeURIComponent(job.beadId)}` : ""}`}
          key={`${metric}-${job.jobId}`}
          aria-label={`${metric === "elapsed" ? "Slow job" : "Recent job"} ${job.jobId}`}
          onClick={() => logClientEvent("explore_job_drilldown", { component: "explore", job_hash: shortHash(job.jobId), bead_hash: job.beadId ? shortHash(job.beadId) : null })}
        >
          <span>{job.jobId}</span>
          <span>{job.specialist}</span>
          <span>{job.status}</span>
          <span>{metric === "elapsed" ? formatDuration(job.elapsedMs) : formatTime(job.updatedAtMs)}</span>
        </a>
      ))}
    </div>
  );
}

function EmptyPanel() {
  return <div className="explore-empty">No matching AgentOps data</div>;
}

function ExploreTabButton({ tab, active, onSelect }: { tab: ExploreTab; active: boolean; onSelect: (tab: ExploreTab) => void }) {
  const label = tab === "agentops" ? "AgentOps" : tab === "prom" ? "Prometheus" : "Forensic";
  return (
    <button type="button" role="tab" aria-selected={active} className={active ? "explore-tab is-active" : "explore-tab"} onClick={() => onSelect(tab)}>
      {tab === "agentops" ? <ServerIcon size={13} /> : tab === "forensic" ? <SearchIcon size={13} /> : <PulseIcon size={13} />}
      <span>{label}</span>
    </button>
  );
}

function ComingSoon({ tab }: { tab: Exclude<ExploreTab, "agentops"> }) {
  const item = FOLLOW_UPS[tab];
  return (
    <article className="explore-coming-soon">
      <span>{item.title}</span>
      <h2>Coming soon</h2>
      <p>{item.text}</p>
      <a href={`/console/beads/feed?issue=${item.bead}`}>{item.bead}</a>
    </article>
  );
}

function tabFromPath(path: string): ExploreTab {
  if (path.includes("/console/explore/forensic")) return "forensic";
  if (path.includes("/console/explore/prom")) return "prom";
  return "agentops";
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(value);
}

function formatDuration(ms: number): string {
  if (!ms) return "n/a";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function formatTime(ms: number): string {
  if (!ms) return "unknown";
  return new Date(ms).toLocaleString();
}
