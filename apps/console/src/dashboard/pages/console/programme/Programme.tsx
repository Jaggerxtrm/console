// /console/programme — native Mercury Programme operator dashboard.
// 13 views: Overview, Revenue, Programme Graph, State & Journal, Identity &
// Provenance, Workstreams, Assignments, Explore, Jira references, Agents,
// Research & decisions, Activity, Source health.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  ProgrammeGoverned,
  ProgrammeSnapshot,
  ProgrammeSnapshotResponse,
} from "../../../../types/programme.ts";
import { useProgrammeData } from "../../../hooks/useProgrammeData.ts";
import { ProgrammeGraphShell } from "./ProgrammeGraph.tsx";
import { ProgrammeEntityDrawer } from "./ProgrammeEntityDrawer.tsx";
import { ChangesView } from "./ChangesView.tsx";
import { ContextBuffer } from "./ContextBuffer.tsx";
import { useProgrammeChanges } from "./useProgrammeChanges.ts";
import "./programme.css";

type ProgrammeView =
  | "overview" | "revenue" | "graph" | "statejournal" | "identity"
  | "workstreams" | "assignments" | "changes" | "explore" | "jira" | "agents"
  | "knowledge" | "activity" | "sourcehealth";

const VIEWS: Array<{ id: ProgrammeView; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "revenue", label: "Revenue" },
  { id: "graph", label: "Programme Graph" },
  { id: "statejournal", label: "State & Journal" },
  { id: "identity", label: "Identity & Provenance" },
  { id: "workstreams", label: "Workstreams" },
  { id: "assignments", label: "Assignments" },
  { id: "changes", label: "Changes" },
  { id: "explore", label: "Explore" },
  { id: "jira", label: "Jira references" },
  { id: "agents", label: "Agents" },
  { id: "knowledge", label: "Research & decisions" },
  { id: "activity", label: "Activity" },
  { id: "sourcehealth", label: "Source health" },
];

export function Programme() {
  const { data, loading, error, reload } = useProgrammeData();
  const changes = useProgrammeChanges();
  const [view, setView] = useState<ProgrammeView>(() => viewFromPath(window.location.pathname));

  useEffect(() => {
    window.history.replaceState({}, "", viewToPath(view));
  }, [view]);

  const snapshot = data?.snapshot ?? null;
  const health = data?.source_health ?? null;
  const changedKeys = useMemo(() => new Set<string>(data?.changes_summary?.changed_entity_keys ?? []), [data?.changes_summary]);

  if (error && !snapshot) {
    return (
      <div className="pd-page">
        <div className="pd-error">Programme snapshot unavailable: {error}</div>
        <button type="button" className="pd-button" onClick={() => void reload({ force: true })}>Retry</button>
      </div>
    );
  }
  if (loading && !snapshot) return <div className="pd-page pd-loading">Loading programme read model…</div>;
  if (!snapshot) return <div className="pd-page pd-loading">Loading programme read model…</div>;

  const healthStatus = health?.status ?? "unknown";

  return (
    <div className="pd-page">
      <div className="pd-topbar">
        <div className="pd-views">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              className={view === v.id ? "pd-view is-active" : "pd-view"}
              onClick={() => setView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
        <div className="pd-health" data-status={healthStatus}>
          <span className="pd-health-dot" />
          {healthStatus === "fresh" ? "live" : healthStatus === "stale" ? "last_successful" : healthStatus}
          <span className="pd-health-sep">·</span>
          <span className="pd-health-sha">{snapshot.programme.short_sha ?? "—"}</span>
          <button type="button" className="pd-refresh" onClick={() => void reload({ force: true })} title="Refresh snapshot">⟳</button>
        </div>
      </div>
      {healthStatus === "degraded" && health?.message ? (
        <div className="pd-banner pd-banner-warn" role="status">{health.message}</div>
      ) : null}
      <div className="pd-content" key={view}>
        {view === "overview" ? <OverviewView snapshot={snapshot} /> : null}
        {view === "revenue" ? <RevenueView snapshot={snapshot} /> : null}
        {view === "graph" ? <ProgrammeGraphShell graph={snapshot.graph} snapshot={snapshot} changesEntityKeys={changedKeys.size > 0 ? changedKeys : undefined} /> : null}
        {view === "statejournal" ? <StateJournalView snapshot={snapshot} /> : null}
        {view === "identity" ? <IdentityView snapshot={snapshot} /> : null}
        {view === "workstreams" ? <WorkstreamsView snapshot={snapshot} changedKeys={changedKeys} /> : null}
        {view === "assignments" ? <AssignmentsView snapshot={snapshot} changedKeys={changedKeys} /> : null}
        {view === "changes" ? <ChangesView snapshot={snapshot} changeSet={changes.changeSet} loading={changes.loading} error={changes.error} onReload={changes.reload} /> : null}
        {view === "explore" ? <ExploreView snapshot={snapshot} /> : null}
        {view === "jira" ? <JiraView snapshot={snapshot} /> : null}
        {view === "agents" ? <AgentsView snapshot={snapshot} /> : null}
        {view === "knowledge" ? <KnowledgeView snapshot={snapshot} /> : null}
        {view === "activity" ? <ActivityView snapshot={snapshot} /> : null}
        {view === "sourcehealth" ? <SourceHealthView snapshot={snapshot} response={data} /> : null}
      </div>
      <ContextBuffer snapshot={snapshot} />
      <ProgrammeEntityDrawer snapshot={snapshot} />
    </div>
  );
}

function viewFromPath(path: string): ProgrammeView {
  for (const v of VIEWS) {
    if (path.includes(`/programme/${v.id}`)) return v.id;
  }
  return "overview";
}

function viewToPath(view: ProgrammeView): string {
  return view === "overview" ? "/console/programme" : `/console/programme/${view}`;
}

// ── Shared UI ────────────────────────────────────────────────────────────────

const GITHUB_BASE = "https://github.com/mercuryintelligence/program";
const JIRA_BASE = "https://mercuryintel.atlassian.net/browse";

/** Canonical source link pinned to the snapshot SHA. Falls back to the branch
 * ref only when the snapshot was built without a resolved SHA — the link still
 * resolves to the exact snapshot ref, never to a moving `master` head. */
function ghUrl(path: string, snapshot?: ProgrammeSnapshot | null): string {
  const ref = snapshot?.programme?.sha ?? snapshot?.programme?.branch ?? "master";
  return `${GITHUB_BASE}/blob/${encodeURIComponent(ref)}/${path}`;
}

function Badge({ value }: { value: unknown }) {
  const text = String(value ?? "UNKNOWN");
  const cls = text.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return <span className={`pd-badge pd-badge-${cls}`}>{text}</span>;
}

function JiraRefs({ refs }: { refs: string[] }) {
  if (!refs || refs.length === 0) return <span className="pd-muted">—</span>;
  return (
    <span className="pd-jira-refs">
      {refs.map((key) => (
        <a key={key} className="pd-link pd-mono" href={`${JIRA_BASE}/${key}`} target="_blank" rel="noreferrer">{key}</a>
      ))}
    </span>
  );
}

function fmtDate(value: unknown): string {
  if (!value) return "—";
  const d = new Date(String(value));
  if (Number.isNaN(d.valueOf())) return String(value);
  return d.toISOString().slice(0, 10);
}

function Panel({ title, sub, children, actions }: { title: string; sub?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="pd-panel">
      <header className="pd-panel-hd">
        <div>
          <div className="pd-panel-title">{title}</div>
          {sub ? <div className="pd-panel-sub">{sub}</div> : null}
        </div>
        {actions}
      </header>
      <div className="pd-panel-body">{children}</div>
    </section>
  );
}

function Card({ label, value, meta }: { label: string; value: string; meta?: string }) {
  return (
    <div className="pd-card">
      <div className="pd-card-label">{label}</div>
      <div className="pd-card-value">{value}</div>
      {meta ? <div className="pd-card-meta">{meta}</div> : null}
    </div>
  );
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="pd-table-wrap pd-scroll-x">
      <table className="pd-table">
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function SectionHd({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="pd-section-hd">
      <h3>{title}</h3>
      {sub ? <span className="pd-muted">{sub}</span> : null}
    </div>
  );
}

function SourceLink({ path, snapshot, label = "Source" }: { path: string; snapshot?: ProgrammeSnapshot | null; label?: string }) {
  return <a className="pd-link" href={ghUrl(path, snapshot)} target="_blank" rel="noreferrer">{label}</a>;
}

/** Δ chip — factual marker that an entity changed in the last visit. */
function DeltaChip({ changed }: { changed: boolean }) {
  if (!changed) return null;
  return <span className="pd-delta-chip" title="changed in last visit">Δ</span>;
}

// ── Views ────────────────────────────────────────────────────────────────────

function OverviewView({ snapshot }: { snapshot: ProgrammeSnapshot }) {
  const ws = snapshot.workstreams ?? [];
  const asg = snapshot.assignments ?? [];
  const b = snapshot.business ?? {};
  const active = ws.filter((w) => /active|in progress|in corso/i.test(w.status ?? "")).length;
  const ops = asg.filter((a) => a.kind === "OPS").length;
  const exp = asg.filter((a) => a.kind === "EXP").length;
  const pct = b.target_customers ? Math.min(100, Math.round(((b.baseline_customers ?? 0) / b.target_customers) * 100)) : 0;
  const lanes = ws.filter((w) => ["WS-009", "WS-004", "WS-003", "WS-001"].includes(w.id));

  return (
    <>
      <div className="pd-grid pd-cards">
        <Card label="Revenue target" value={`${b.baseline_customers ?? "—"} / ${b.target_customers ?? "—"}`} meta={String(b.deadline ?? "deadline unknown")} />
        <Card label="Active workstreams" value={String(active)} meta={`${ws.length} programme workstreams`} />
        <Card label="Assignments" value={String(asg.length)} meta={`${ops} OPS · ${exp} EXP`} />
        <Card label="Operator-linked refs" value={String((snapshot.operator_input_refs ?? []).length)} meta="not a live Jira task count" />
      </div>
      <div className="pd-grid pd-two">
        <Panel title="Revenue mission" sub="WS-009">
          <div className="pd-progress-row">
            <div className="pd-big">{b.baseline_customers ?? "—"} <small>/ {b.target_customers ?? "—"}</small></div>
            <Badge value="ACTIVE" />
          </div>
          <div className="pd-progress"><div className="pd-progress-fill" style={{ width: `${pct}%` }} /></div>
          <p className="pd-muted">{b.evidence_note ?? ""}</p>
        </Panel>
        <Panel title="Latest programme activity" sub={snapshot.programme.short_sha ?? ""}>
          <div className="pd-list">
            {(snapshot.activity ?? []).slice(0, 7).map((c) => (
              <div key={c.sha} className="pd-list-item">
                <div className="pd-list-main">
                  <div className="pd-list-title">{c.subject}</div>
                  <div className="pd-sub"><span className="pd-mono">{(c.sha ?? "").slice(0, 7)}</span> · {fmtDate(c.date)}</div>
                </div>
                <a className="pd-link" href={c.url} target="_blank" rel="noreferrer">Open</a>
              </div>
            ))}
            {(snapshot.activity ?? []).length === 0 ? <div className="pd-muted">No activity.</div> : null}
          </div>
        </Panel>
      </div>
      <SectionHd title="Priority programme lanes" sub="read-only projection" />
      <Panel title="Lanes">
        <Table head={["ID", "Workstream", "State", "Jira", "Updated"]}>
          {lanes.map((w) => (
            <tr key={w.id}>
              <td className="pd-mono">{w.id}</td>
              <td><div>{w.title}</div><div className="pd-sub">{w.path}</div></td>
              <td><Badge value={w.status} /></td>
              <td><JiraRefs refs={w.jira_refs} /></td>
              <td>{fmtDate(w.updated_at)}</td>
            </tr>
          ))}
        </Table>
      </Panel>
    </>
  );
}

function RevenueView({ snapshot }: { snapshot: ProgrammeSnapshot }) {
  const b = snapshot.business ?? {};
  const pct = b.target_customers ? Math.min(100, Math.round(((b.baseline_customers ?? 0) / b.target_customers) * 100)) : 0;
  const lanes = (snapshot.workstreams ?? []).filter((w) => ["WS-009", "WS-004", "WS-003", "WS-005", "WS-002", "WS-008"].includes(w.id));
  return (
    <>
      <div className="pd-grid pd-two">
        <Panel title="90-day objective" sub="WS-009 current accepted STATE">
          <div className="pd-progress-row">
            <div className="pd-big">{b.baseline_customers ?? "—"} <small>/ {b.target_customers ?? "—"}</small></div>
            <Badge value="ACTIVE" />
          </div>
          <div className="pd-muted">deadline {b.deadline ?? "unknown"} · baseline {b.baseline_evidence_class ?? "—"} from {b.baseline_source ?? "—"}</div>
          <div className="pd-progress"><div className="pd-progress-fill" style={{ width: `${pct}%` }} /></div>
          <p className="pd-muted">{b.evidence_note ?? ""}</p>
        </Panel>
        <Panel title="Operator boundary">
          <div className="pd-list">
            <div className="pd-list-item"><div className="pd-list-main"><div className="pd-list-title">Human-only requests</div><div className="pd-sub">Use Jira operator-input; never put credentials or private customer data in programme artifacts.</div></div></div>
            <div className="pd-list-item"><div className="pd-list-main"><div className="pd-list-title">Routine execution</div><div className="pd-sub">Already-authorized repository work continues through Beads, independent review and tests.</div></div></div>
          </div>
        </Panel>
      </div>
      <SectionHd title="Revenue-supporting lanes" sub="WS-009 coordinates; it does not absorb implementation" />
      <Panel title="Lanes">
        <Table head={["ID", "Lane", "State", "Jira", ""]}>
          {lanes.map((w) => (
            <tr key={w.id}>
              <td className="pd-mono">{w.id}</td>
              <td>{w.title}</td>
              <td><Badge value={w.status} /></td>
              <td><JiraRefs refs={w.jira_refs} /></td>
              <td><SourceLink path={w.path} snapshot={snapshot} /></td>
            </tr>
          ))}
        </Table>
      </Panel>
    </>
  );
}

function StateJournalView({ snapshot }: { snapshot: ProgrammeSnapshot }) {
  const sem = snapshot.state_history_semantics ?? {};
  const journals = [...(snapshot.journals ?? [])].sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
  return (
    <>
      <div className="pd-banner">
        <strong>State precedence:</strong> {sem.current_state_precedence ?? ""}
        <div className="pd-muted">Journal and state are evidence/history surfaces; wrapper-owned publication facts remain distinct.</div>
      </div>
      <SectionHd title="Current state surfaces" sub="materialized coordinator/read-model state" />
      <Panel title="State">
        <Table head={["ID", "State", "Status", "Actor", "Assignment", "Updated", ""]}>
          {(snapshot.state_records ?? []).map((s) => (
            <tr key={s.id}>
              <td className="pd-mono">{s.id}</td>
              <td><div>{s.title}</div><div className="pd-sub">{s.path}</div></td>
              <td><Badge value={s.status} /></td>
              <td>{s.actor_id ?? "—"}</td>
              <td>{s.assignment_id ?? "—"}</td>
              <td>{fmtDate(s.updated_at)}</td>
              <td><SourceLink path={s.path} snapshot={snapshot} /></td>
            </tr>
          ))}
        </Table>
      </Panel>
      <SectionHd title="Journal timeline" sub="append-only evidence/history" />
      <Panel title="Journals">
        <Table head={["Date", "Journal", "Class", "Evidence cutoff", "Publication", ""]}>
          {journals.map((j) => (
            <tr key={j.id}>
              <td>{j.date ?? "—"}</td>
              <td>{j.title}</td>
              <td><Badge value={j.classification ?? j.authority_class} /></td>
              <td>{j.evidence_cutoff ?? "—"}</td>
              <td>{j.publication ?? "—"}</td>
              <td><SourceLink path={j.path} snapshot={snapshot} label="Journal" /></td>
            </tr>
          ))}
        </Table>
      </Panel>
      <SectionHd title="Wrapper publication facts" sub="not authored by the AI report body" />
      <Panel title="Publications">
        <Table head={["Run", "State slot", "Assignment", "Branch", "PR", "Evidence"]}>
          {(snapshot.publication_facts ?? []).map((p) => (
            <tr key={p.id}>
              <td>{p.run_date}</td>
              <td className="pd-mono">{p.slot}</td>
              <td>{p.assignment_id ?? "—"}</td>
              <td className="pd-mono">{p.branch ?? "—"}</td>
              <td>{p.pull_request ? <a className="pd-link" href={p.pull_request} target="_blank" rel="noreferrer">PR</a> : "—"}</td>
              <td><Badge value={p.evidence_class} /></td>
            </tr>
          ))}
        </Table>
      </Panel>
    </>
  );
}

function IdentityView({ snapshot }: { snapshot: ProgrammeSnapshot }) {
  const p = snapshot.provenance ?? { current: {}, rules: [], live_receipt_gate: "" };
  const c = p.current as Record<string, boolean>;
  return (
    <>
      <div className="pd-grid pd-cards">
        <Card label="Actor registry" value={c.programme_actor_registry ? "YES" : "NO"} meta="logical programme actors" />
        <Card label="State bindings" value={c.state_actor_assignment_fields ? "YES" : "NO"} meta="actor / assignment fields" />
        <Card label="Wrapper publication facts" value={c.wrapper_publication_facts ? "YES" : "NO"} meta="branch / PR evidence" />
        <Card label="XTRM mutation receipts" value={c.xtrm_mutation_receipts ? "LIVE" : "NOT YET"} meta={p.live_receipt_gate ?? "canonical XTRM gate required"} />
      </div>
      <div className="pd-grid pd-two">
        <Panel title="Attribution rules" sub="logical actor ≠ credential principal">
          <div className="pd-list">
            {(p.rules ?? []).map((r) => <div key={r} className="pd-list-item"><div className="pd-list-main"><div className="pd-list-title">{r}</div></div></div>)}
          </div>
        </Panel>
        <Panel title="Current boundary">
          <p>Programme state can expose actor and assignment fields today. Publication facts can be read from wrapper-owned state. External principal, execution receipt and attested mutation identity remain UNKNOWN unless a canonical XTRM receipt binds them.</p>
          <p className="pd-muted">Do not infer authorship from GitHub/Jira username, branch name, prose, label or model.</p>
        </Panel>
      </div>
      <SectionHd title="Publication provenance" sub="unknown stays unknown" />
      <Panel title="Provenance">
        <Table head={["Run", "Assignment", "Logical actor", "Principal set", "Branch", "PR"]}>
          {(snapshot.publication_facts ?? []).map((x) => (
            <tr key={x.id}>
              <td>{x.run_date}</td>
              <td>{x.assignment_id ?? "—"}</td>
              <td>{x.logical_actor}</td>
              <td>{x.principal_set}</td>
              <td className="pd-mono">{x.branch ?? "—"}</td>
              <td>{x.pull_request ? <a className="pd-link" href={x.pull_request} target="_blank" rel="noreferrer">Open</a> : "—"}</td>
            </tr>
          ))}
        </Table>
      </Panel>
    </>
  );
}

function WorkstreamsView({ snapshot, changedKeys }: { snapshot: ProgrammeSnapshot; changedKeys: Set<string> }) {
  return (
    <Panel title="Workstreams">
      <Table head={["ID", "Workstream", "State", "Plan", "Jira", "Updated", ""]}>
        {(snapshot.workstreams ?? []).map((w) => (
          <tr key={w.id}>
            <td className="pd-mono"><DeltaChip changed={changedKeys.has(w.graph_id ?? w.id)} /> {w.id}</td>
            <td><div>{w.title}</div><div className="pd-sub">{w.path}</div></td>
            <td><Badge value={w.status} /></td>
            <td>{w.has_plan ? <Badge value="PLAN" /> : "—"}</td>
            <td><JiraRefs refs={w.jira_refs} /></td>
            <td>{fmtDate(w.updated_at)}</td>
            <td><SourceLink path={w.path} snapshot={snapshot} /></td>
          </tr>
        ))}
      </Table>
    </Panel>
  );
}

function AssignmentsView({ snapshot, changedKeys }: { snapshot: ProgrammeSnapshot; changedKeys: Set<string> }) {
  const [filter, setFilter] = useState<"ALL" | "OPS" | "EXP">("ALL");
  const items = (snapshot.assignments ?? []).filter((a) => filter === "ALL" || a.kind === filter);
  return (
    <>
      <div className="pd-filterbar">
        {(["ALL", "OPS", "EXP"] as const).map((f) => (
          <button key={f} type="button" className={filter === f ? "pd-filter is-active" : "pd-filter"} onClick={() => setFilter(f)}>{f}</button>
        ))}
      </div>
      <Panel title="Assignments">
        <Table head={["ID", "Assignment", "Kind", "State", "Workstream", "Jira", ""]}>
          {items.map((a) => (
            <tr key={a.path}>
              <td className="pd-mono"><DeltaChip changed={changedKeys.has(a.graph_id ?? a.id)} /> {a.id}</td>
              <td><div>{a.title || a.id}</div><div className="pd-sub">{a.path}</div></td>
              <td><Badge value={a.kind} /></td>
              <td><Badge value={a.status} /></td>
              <td>{String(a.workstream ?? "—")}</td>
              <td><JiraRefs refs={a.jira_refs} /></td>
              <td><SourceLink path={a.path} snapshot={snapshot} /></td>
            </tr>
          ))}
        </Table>
      </Panel>
    </>
  );
}

type FacetKey = "kind" | "status" | "workstream" | "owner" | "repository" | "jira" | "authority" | "evidence" | "source";

const FACETS: Array<{ key: FacetKey; label: string }> = [
  { key: "kind", label: "Entity kind" },
  { key: "status", label: "Lifecycle state" },
  { key: "workstream", label: "Workstream" },
  { key: "owner", label: "Owner / actor" },
  { key: "repository", label: "Repository" },
  { key: "jira", label: "Jira reference" },
  { key: "authority", label: "Authority class" },
  { key: "evidence", label: "Evidence class" },
  { key: "source", label: "State source" },
];

interface ExploreRow {
  /** Collision-safe entity key (graph node id). Never kind+display_id. */
  entity_key: string;
  /** Display id (may be shared across collisions). */
  id: string;
  kind: string;
  title: string;
  status: string;
  workstream: string;
  owner: string;
  repository: string;
  jira: string;
  authority: string;
  evidence: string;
  source: string;
}

/** Graph-node-aware key for a collection record. Collision-free records map
 * to their graph node id; collision duplicates (e.g. EXP-005) keep the
 * path-qualified graph id so each row is uniquely addressed. */
function exploreKey(record: { id: string; graph_id?: string; path?: string }, snapshot: ProgrammeSnapshot): string {
  if (record.graph_id && record.graph_id !== record.id) return record.graph_id;
  const node = snapshot.graph.nodes.find((n) => n.id === record.id);
  return node?.id ?? (record.path ? `${record.id}::${record.path}` : record.id);
}

function authorityOf(value: unknown): string {
  if (!value) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "object") return String((value as Record<string, unknown>)["source"] ?? "—");
  return String(value);
}

function exploreRows(snapshot: ProgrammeSnapshot): ExploreRow[] {
  const rows: ExploreRow[] = [];
  const push = (rec: Omit<ExploreRow, "entity_key"> & { path?: string; graph_id?: string }) => {
    rows.push({ ...rec, entity_key: exploreKey(rec, snapshot) });
  };
  for (const w of snapshot.workstreams ?? []) push({ id: w.id, kind: "workstream", title: w.title, status: w.status, workstream: w.id, owner: "—", repository: "mercuryintelligence/program", jira: w.jira_refs.join(","), authority: "canonical", evidence: "derived_from_checkout", source: w.state_path ?? w.path, path: w.path, graph_id: w.graph_id });
  for (const a of snapshot.assignments ?? []) push({ id: a.id, kind: "assignment", title: a.title, status: a.status, workstream: String(a.workstream ?? "—"), owner: String(a.metadata?.["owner"] ?? "—"), repository: "mercuryintelligence/program", jira: a.jira_refs.join(","), authority: authorityOf(a.authority), evidence: "derived_from_checkout", source: a.path, path: a.path, graph_id: a.graph_id });
  for (const r of snapshot.research ?? []) push({ id: r.id, kind: "research", title: r.title, status: r.status, workstream: "—", owner: String(r.metadata?.["owner"] ?? "—"), repository: "mercuryintelligence/program", jira: r.jira_refs.join(","), authority: authorityOf(r.authority), evidence: "derived_from_checkout", source: r.path, path: r.path, graph_id: r.graph_id });
  for (const d of snapshot.decisions ?? []) push({ id: d.id, kind: "decision", title: d.title, status: d.status, workstream: "—", owner: String(d.metadata?.["owner"] ?? "—"), repository: "mercuryintelligence/program", jira: d.jira_refs.join(","), authority: authorityOf(d.authority), evidence: "canonical", source: d.path, path: d.path, graph_id: d.graph_id });
  for (const p of snapshot.proposals ?? []) push({ id: p.id, kind: "proposal", title: p.title, status: p.status, workstream: "—", owner: String(p.metadata?.["owner"] ?? "—"), repository: "mercuryintelligence/program", jira: p.jira_refs.join(","), authority: authorityOf(p.authority), evidence: "non_authoritative", source: p.path, path: p.path, graph_id: p.graph_id });
  for (const s of snapshot.state_records ?? []) push({ id: s.id, kind: "state", title: s.title, status: s.status, workstream: "—", owner: s.actor_id ?? "—", repository: "mercuryintelligence/program", jira: "", authority: "operational", evidence: "machine_recorded", source: s.path, path: s.path });
  for (const j of snapshot.journals ?? []) push({ id: j.id, kind: "journal", title: j.title, status: j.classification ?? j.authority_class, workstream: "—", owner: "—", repository: "mercuryintelligence/program", jira: j.refs.join(","), authority: j.authority_class, evidence: "dated_history", source: j.path, path: j.path });
  for (const pub of snapshot.publication_facts ?? []) push({ id: pub.id, kind: "publication", title: pub.title, status: "RECORDED", workstream: "—", owner: pub.assignment_id ?? "—", repository: "mercuryintelligence/program", jira: "", authority: "wrapper_recorded", evidence: pub.evidence_class, source: pub.source_path, path: pub.source_path });
  return rows;
}

function ExploreView({ snapshot }: { snapshot: ProgrammeSnapshot }) {
  const [facet, setFacet] = useState<FacetKey | null>(null);
  const [value, setValue] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const rows = useMemo(() => exploreRows(snapshot), [snapshot]);
  const counts = useMemo(() => {
    const out = {} as Record<FacetKey, Map<string, number>>;
    for (const f of FACETS) out[f.key] = new Map();
    for (const r of rows) {
      for (const f of FACETS) {
        for (const part of String(r[f.key]).split(",").map((s) => s.trim()).filter(Boolean)) {
          out[f.key].set(part, (out[f.key].get(part) ?? 0) + 1);
        }
      }
    }
    return out;
  }, [rows]);
  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (query && !JSON.stringify(r).toLowerCase().includes(query.toLowerCase())) return false;
      if (facet && value) {
        const parts = String(r[facet]).split(",").map((s) => s.trim());
        if (!parts.includes(value)) return false;
      }
      return true;
    });
  }, [rows, facet, value, query]);

  return (
    <>
      <div className="pd-filterbar">
        <input className="pd-search" placeholder="Filter entities…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="pd-muted">{filtered.length} / {rows.length} entities</span>
      </div>
      {FACETS.map((f) => (
        <div key={f.key} className="pd-facet-group">
          <span className="pd-facet-label">{f.label}</span>
          <div className="pd-facets">
            {[...(counts[f.key]?.entries() ?? [])].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([v, n]) => (
              <button
                key={v}
                type="button"
                className={facet === f.key && value === v ? "pd-facet is-active" : "pd-facet"}
                onClick={() => {
                  if (facet === f.key && value === v) { setFacet(null); setValue(null); }
                  else { setFacet(f.key); setValue(v); }
                }}
              >
                {v} <em>{n}</em>
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="pd-table-wrap pd-scroll-x">
        <table className="pd-table">
          <thead><tr>{["ID", "Kind", "Title", "State", "Workstream", "Owner", "Repository", "Jira", "Authority", "Evidence"].map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>
            {filtered.slice(0, 300).map((r) => (
              <tr key={r.entity_key}>
                <td className="pd-mono">{r.id}</td>
                <td>{r.kind}</td>
                <td>{r.title}</td>
                <td><Badge value={r.status} /></td>
                <td>{r.workstream}</td>
                <td>{r.owner}</td>
                <td>{r.repository}</td>
                <td>{r.jira}</td>
                <td>{r.authority}</td>
                <td>{r.evidence}</td>
              </tr>
            ))}
            {filtered.length === 0 ? <tr><td colSpan={10} className="pd-muted">No matching records.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

function JiraView({ snapshot }: { snapshot: ProgrammeSnapshot }) {
  return (
    <>
      <div className="pd-banner">{snapshot.evidence_boundary.jira ?? ""}</div>
      <Panel title="Jira references">
        <Table head={["Issue", "Summary", "State", "Priority", "Updated"]}>
          {(snapshot.jira_refs ?? []).map((r) => (
            <tr key={r.key}>
              <td><a className="pd-link pd-mono" href={`${JIRA_BASE}/${r.key}`} target="_blank" rel="noreferrer">{r.key}</a></td>
              <td><div>Referenced by programme artifacts</div><div className="pd-sub">{r.seen_in.slice(0, 3).join(" · ")}</div></td>
              <td><Badge value="PROGRAMME REF" /></td>
              <td>—</td>
              <td>—</td>
            </tr>
          ))}
        </Table>
      </Panel>
    </>
  );
}

function AgentsView({ snapshot }: { snapshot: ProgrammeSnapshot }) {
  const items = snapshot.agents ?? [];
  if (items.length === 0) return <div className="pd-muted">No registered actors.</div>;
  return (
    <div className="pd-agent-grid">
      {items.map((a) => (
        <a key={a.id} className="pd-agent" href={ghUrl(a.path, snapshot)} target="_blank" rel="noreferrer">
          <div className="pd-agent-id">{a.id}</div>
          <div className="pd-agent-title">{a.title}</div>
          <div className="pd-sub">{a.role} · {fmtDate(a.updated_at)}</div>
        </a>
      ))}
    </div>
  );
}

function KnowledgeView({ snapshot }: { snapshot: ProgrammeSnapshot }) {
  const mk = (items: ProgrammeGoverned[]) => items.map((x) => (
    <tr key={x.path}>
      <td className="pd-mono">{x.id}</td>
      <td>{x.title}</td>
      <td><Badge value={x.status} /></td>
      <td>{String(x.authority ?? "—")}</td>
      <td><JiraRefs refs={x.jira_refs} /></td>
      <td><SourceLink path={x.path} snapshot={snapshot} /></td>
    </tr>
  ));
  return (
    <>
      <SectionHd title="Decisions" sub="canonical ADRs" />
      <Panel title="Decisions"><Table head={["ID", "Decision", "State", "Authority", "Jira", ""]}>{mk(snapshot.decisions ?? [])}</Table></Panel>
      <SectionHd title="Research" sub="evidence, not implementation truth" />
      <Panel title="Research"><Table head={["ID", "Research", "State", "Authority", "Jira", ""]}>{mk(snapshot.research ?? [])}</Table></Panel>
      <SectionHd title="Proposals" sub="non-authoritative until promoted" />
      <Panel title="Proposals"><Table head={["ID", "Proposal", "State", "Authority", "Jira", ""]}>{mk(snapshot.proposals ?? [])}</Table></Panel>
    </>
  );
}

function ActivityView({ snapshot }: { snapshot: ProgrammeSnapshot }) {
  const items = snapshot.activity ?? [];
  return (
    <Panel title="Activity">
      <div className="pd-list">
        {items.map((c) => (
          <div key={c.sha} className="pd-list-item">
            <div className="pd-list-main">
              <div className="pd-list-title">{c.subject}</div>
              <div className="pd-sub">{fmtDate(c.date)} · <span className="pd-mono">{(c.sha ?? "").slice(0, 10)}</span></div>
            </div>
            <a className="pd-link" href={c.url} target="_blank" rel="noreferrer">Commit</a>
          </div>
        ))}
        {items.length === 0 ? <div className="pd-muted">No activity.</div> : null}
      </div>
    </Panel>
  );
}

function SourceHealthView({ snapshot, response }: { snapshot: ProgrammeSnapshot; response: ProgrammeSnapshotResponse | null }) {
  const health = response?.source_health ?? snapshot.source_health;
  const rows: Array<{ datasource: string; status: string; note: string }> = [
    { datasource: "Programme GitHub (mercuryintelligence/program)", status: health?.status ?? "unknown", note: health?.message ?? "server-side read, bounded cache" },
    { datasource: "Jira live state", status: "unknown", note: "programme references only; no live Jira adapter without the ISSUE-87 credential boundary" },
    { datasource: "Beads / repository-local", status: "unknown", note: snapshot.evidence_boundary.beads ?? "requires a fresh local read or governed board-audit transport" },
    { datasource: "Runtime / production", status: "unknown", note: snapshot.evidence_boundary.runtime ?? "requires current operational evidence" },
    { datasource: "XTRM provenance receipts", status: snapshot.provenance.current.xtrm_mutation_receipts ? "live" : "unknown", note: snapshot.provenance.live_receipt_gate },
  ];
  return (
    <>
      <div className="pd-banner">A GitHub/Jira/Beads/runtime/provenance datasource failure is never silently presented as healthy programme truth.</div>
      <Panel title="Source health" sub={`snapshot built ${new Date(snapshot.generated_at).toISOString()}`}>
        <Table head={["Datasource", "State", "Note"]}>
          {rows.map((r) => (
            <tr key={r.datasource}>
              <td>{r.datasource}</td>
              <td><Badge value={r.status} /></td>
              <td className="pd-muted">{r.note}</td>
            </tr>
          ))}
        </Table>
      </Panel>
    </>
  );
}
