import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { DatabaseIcon, GearIcon, GraphIcon, PulseIcon, XIcon } from "@primer/octicons-react";
import { selectRepos, selectSelection, useShellStore } from "../../stores/shell.ts";
import { useChains, type ChainSummary } from "../../hooks/useChains.ts";
import { beadSideDrawer } from "../../hooks/useBeadSideDrawer.ts";

type DataSource = "specialists" | "beads" | "github" | "materializer";
type LabField = "chain" | "role" | "status" | "bead" | "latency" | "model" | "updated";
type DrawerTarget =
  | { kind: "chain"; chain: ChainSummary }
  | { kind: "template"; template: QueryTemplate }
  | { kind: "entity"; title: string; body: string; meta: string };

interface QueryTemplate {
  id: string;
  title: string;
  datasource: DataSource;
  query: string;
  fields: LabField[];
}

const FIELD_LABEL: Record<LabField, string> = {
  chain: "Chain",
  role: "Roles",
  status: "Status",
  bead: "Bead",
  latency: "Latency",
  model: "Model",
  updated: "Updated",
};

const TEMPLATES: QueryTemplate[] = [
  {
    id: "active-specialist-chains",
    title: "Active specialist chains",
    datasource: "specialists",
    query: "from specialists.chains where status in (starting,running,waiting,error) order by updated desc limit 20",
    fields: ["chain", "role", "status", "bead", "latency", "updated"],
  },
  {
    id: "evidence-ready-beads",
    title: "Evidence-ready beads",
    datasource: "beads",
    query: "from beads.feed where evidence_refs > 0 or specialist_runs > 0 group by priority,status",
    fields: ["bead", "status", "role", "updated"],
  },
  {
    id: "github-materializer-lag",
    title: "GitHub materializer lag",
    datasource: "github",
    query: "from github.events join materializer.cursors summarize freshness by repo,resource",
    fields: ["status", "latency", "updated"],
  },
];

const DATASOURCES: Array<{ id: DataSource; label: string; note: string }> = [
  { id: "specialists", label: "specialists", note: "live chains + recent history" },
  { id: "beads", label: "beads", note: "state bridge / substrate later" },
  { id: "github", label: "github", note: "external adapter" },
  { id: "materializer", label: "materializer", note: "bridge health" },
];

export function Operations() {
  const selection = useShellStore(selectSelection);
  const repos = useShellStore(selectRepos);
  const selectedRepo = selection.repo ? repos.find((repo) => repo.fullName === selection.repo) : null;
  const repoKeys = useMemo(() => selectedRepo ? [selectedRepo.beadsProjectId, selectedRepo.beadsProjectName, selectedRepo.fullName, selectedRepo.displayName].filter((value): value is string => Boolean(value)) : [], [selectedRepo]);
  const { chains, loading, error } = useChains({ repoKeys });
  const [datasource, setDatasource] = useState<DataSource>("specialists");
  const [activeTemplateId, setActiveTemplateId] = useState(TEMPLATES[0].id);
  const activeTemplate = TEMPLATES.find((template) => template.id === activeTemplateId) ?? TEMPLATES[0];
  const [query, setQuery] = useState(activeTemplate.query);
  const [fields, setFields] = useState<Set<LabField>>(new Set(activeTemplate.fields));
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null);
  const visibleChains = useMemo(() => chains.filter((chain) => matchesQuery(chain, query)).slice(0, 12), [chains, query]);
  const pulse = useMemo(() => buildPulse(chains), [chains]);

  const applyTemplate = (template: QueryTemplate) => {
    setActiveTemplateId(template.id);
    setDatasource(template.datasource);
    setQuery(template.query);
    setFields(new Set(template.fields));
    setDrawer({ kind: "template", template });
  };

  const toggleField = (field: LabField) => {
    setFields((current) => {
      const next = new Set(current);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  };

  return (
    <section className="operations-lab">
      <aside className="operations-scope">
        <div className="operations-scope-head">
          <span className="operations-eyebrow">Datasource</span>
          <select value={datasource} onChange={(event) => setDatasource(event.target.value as DataSource)}>
            {DATASOURCES.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}
          </select>
        </div>
        <div className="operations-source-list">
          {DATASOURCES.map((source) => (
            <button key={source.id} type="button" className={datasource === source.id ? "operations-source is-active" : "operations-source"} onClick={() => setDatasource(source.id)}>
              <span className={`operations-dot is-${source.id}`} />
              <span>{source.label}</span>
              <small>{source.note}</small>
            </button>
          ))}
        </div>
        <div className="operations-template-list">
          <span className="operations-eyebrow">Templates</span>
          {TEMPLATES.map((template) => (
            <button key={template.id} type="button" className={activeTemplateId === template.id ? "operations-template is-active" : "operations-template"} onClick={() => applyTemplate(template)}>
              <b>{template.title}</b>
              <span>{template.datasource}</span>
            </button>
          ))}
        </div>
      </aside>

      <main className="operations-main">
        <div className="operations-pulse" aria-label="Operations pulse">
          <PulseCell label="chains" value={chains.length} note={loading ? "loading" : error ? "degraded" : "current scope"} />
          <PulseCell label="active" value={pulse.active} note="running/waiting" />
          <PulseCell label="failed" value={pulse.failed} note="needs review" tone={pulse.failed > 0 ? "warn" : undefined} />
          <PulseCell label="roles" value={pulse.roles} note="unique" />
          <PulseCell label="p95 latency" value={`${pulse.p95}s`} note="local estimate" />
        </div>

        <section className="operations-query-panel">
          <header className="operations-panel-head">
            <span><DatabaseIcon size={12} /> Query</span>
            <button type="button" onClick={() => setDrawer({ kind: "entity", title: "Save view", body: "View persistence is deferred; this slice keeps query and field state local.", meta: "local state" })}>save view</button>
          </header>
          <textarea value={query} onChange={(event) => setQuery(event.target.value)} spellCheck={false} />
          <div className="operations-field-strip">
            {(Object.keys(FIELD_LABEL) as LabField[]).map((field) => (
              <label key={field} className={fields.has(field) ? "is-active" : ""}>
                <input type="checkbox" checked={fields.has(field)} onChange={() => toggleField(field)} />
                <span>{FIELD_LABEL[field]}</span>
              </label>
            ))}
          </div>
        </section>

        <section className="operations-grid">
          <Panel title="Chain results" action={<button type="button" onClick={() => setDrawer({ kind: "entity", title: "Result boundary", body: "Rows use live specialist chain summaries when available; empty scopes keep the panel structure visible for Console design validation.", meta: datasource })}>boundary</button>}>
            <div className="operations-table">
              <div className="operations-row is-head">{renderCells(fields)}</div>
              {visibleChains.length > 0 ? visibleChains.map((chain) => <ChainRow key={chain.chainId} chain={chain} fields={fields} onOpen={() => setDrawer({ kind: "chain", chain })} />) : <div className="operations-empty-row">No matching chains in this scope.</div>}
            </div>
          </Panel>
          <Panel title="Latency buckets">
            <Bucket label="< 1m" value={chains.filter((chain) => chain.elapsedMs < 60_000).length} />
            <Bucket label="1m-10m" value={chains.filter((chain) => chain.elapsedMs >= 60_000 && chain.elapsedMs < 600_000).length} />
            <Bucket label="10m+" value={chains.filter((chain) => chain.elapsedMs >= 600_000).length} />
          </Panel>
          <Panel title="Template queue">
            <div className="operations-template-mini">
              {TEMPLATES.map((template) => <button key={template.id} type="button" onClick={() => setDrawer({ kind: "template", template })}>{template.title}<span>{template.datasource}</span></button>)}
            </div>
          </Panel>
        </section>
      </main>

      {drawer ? <OperationsDrawer target={drawer} onClose={() => setDrawer(null)} /> : null}
    </section>
  );
}

function ChainRow({ chain, fields, onOpen }: { chain: ChainSummary; fields: Set<LabField>; onOpen: () => void }) {
  const cells: Partial<Record<LabField, string>> = {
    chain: chain.chainId,
    role: chain.roles.map((role) => role.role).join(", ") || "unknown",
    status: chain.status,
    bead: chain.rootBeadId,
    latency: `${Math.round(chain.elapsedMs / 1000)}s`,
    model: chain.jobs.find((job) => job.model)?.model ?? "-",
    updated: formatElapsed(chain.lastUpdatedAt),
  };
  return <button type="button" className="operations-row" onClick={onOpen}>{[...fields].map((field) => <span key={field}>{cells[field]}</span>)}</button>;
}

function OperationsDrawer({ target, onClose }: { target: DrawerTarget; onClose: () => void }) {
  return (
    <div className="operations-drawer-backdrop" onClick={onClose}>
      <aside className="operations-drawer" onClick={(event) => event.stopPropagation()}>
        <header>
          <span>{target.kind}</span>
          <button type="button" aria-label="close operations drawer" onClick={onClose}><XIcon size={14} /></button>
        </header>
        {target.kind === "chain" ? (
          <div className="operations-drawer-body">
            <h2>{target.chain.chainId}</h2>
            <p>{target.chain.lastMessage || "No last output captured."}</p>
            <dl>
              <div><dt>status</dt><dd>{target.chain.status}</dd></div>
              <div><dt>jobs</dt><dd>{target.chain.jobs.length}</dd></div>
              <div><dt>root bead</dt><dd>{target.chain.rootBeadId}</dd></div>
            </dl>
            <button type="button" className="ide-btn" onClick={() => beadSideDrawer.open(target.chain.rootBeadId)}>Open bead inspector</button>
          </div>
        ) : target.kind === "template" ? (
          <div className="operations-drawer-body">
            <h2>{target.template.title}</h2>
            <p>{target.template.query}</p>
            <dl>
              <div><dt>datasource</dt><dd>{target.template.datasource}</dd></div>
              <div><dt>fields</dt><dd>{target.template.fields.join(", ")}</dd></div>
            </dl>
          </div>
        ) : (
          <div className="operations-drawer-body">
            <h2>{target.title}</h2>
            <p>{target.body}</p>
            <dl><div><dt>scope</dt><dd>{target.meta}</dd></div></dl>
          </div>
        )}
      </aside>
    </div>
  );
}

function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="operations-panel"><header><span>{title}</span>{action}</header>{children}</section>;
}

function PulseCell({ label, value, note, tone }: { label: string; value: string | number; note: string; tone?: "warn" }) {
  return <button type="button" className={tone === "warn" ? "operations-pulse-cell is-warn" : "operations-pulse-cell"}><span>{label}</span><b>{value}</b><small>{note}</small></button>;
}

function Bucket({ label, value }: { label: string; value: number }) {
  return <button type="button" className="operations-bucket"><span>{label}</span><b>{value}</b></button>;
}

function renderCells(fields: Set<LabField>) {
  return [...fields].map((field) => <span key={field}>{FIELD_LABEL[field]}</span>);
}

function matchesQuery(chain: ChainSummary, query: string): boolean {
  const needle = query.toLowerCase().match(/where\s+.*?(running|waiting|failed|error|done|starting)/)?.[1];
  if (!needle) return true;
  return chain.status.toLowerCase().includes(needle) || query.toLowerCase().includes(chain.status.toLowerCase());
}

function buildPulse(chains: ChainSummary[]) {
  const elapsed = chains.map((chain) => Math.round(chain.elapsedMs / 1000)).sort((a, b) => a - b);
  const p95 = elapsed.length ? elapsed[Math.min(elapsed.length - 1, Math.floor(elapsed.length * 0.95))] : 0;
  return {
    active: chains.filter((chain) => chain.status === "starting" || chain.status === "running" || chain.status === "waiting").length,
    failed: chains.filter((chain) => chain.status === "failed" || chain.status === "error").length,
    roles: new Set(chains.flatMap((chain) => chain.roles.map((role) => role.role))).size,
    p95,
  };
}

function formatElapsed(updatedAt: string): string {
  const delta = Date.now() - Date.parse(updatedAt);
  if (!Number.isFinite(delta) || delta < 0) return "now";
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
