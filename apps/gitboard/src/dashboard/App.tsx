import { useEffect, useState } from "react";
import { GithubPanel } from "./components/github/GithubPanel.tsx";
import { useRepoTree } from "./hooks/useRepoTree.ts";
import { TopBar } from "./components/shell/TopBar.tsx";
import { Sidebar } from "./components/shell/Sidebar.tsx";
import { useShellStore, selectTheme } from "./stores/shell.ts";
import type { TabId } from "../types/shell.ts";
import { MainPane } from "./components/shell/MainPane.tsx";
import { BeadSideDrawer } from "./pages/console/BeadSideDrawer.tsx";
import { useGithubActivity } from "./hooks/useGithubActivity.ts";
import { SourcesPanel } from "./components/settings/SourcesPanel.tsx";

type Tab = "github" | "console" | "settings";
type View = "dashboard" | "design-preview";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "github", label: "GitHub" },
  { id: "console", label: "Console" },
  { id: "settings", label: "Settings" },
];


export function App() {
  const path = window.location.pathname;
  useEffect(() => {
    const store = useShellStore.getState();
    if (path.includes("/gitboard/beads") || path.endsWith("/console") || path.includes("/gitboard/console/")) {
      if (store.selection.surface !== "console") store.setSurface("console");
      const tab = routeTab(path);
      if (tab && store.selection.tab !== tab) store.setTab(tab);
    }
  }, [path]);
  if (path.endsWith("/legacy")) return <DashboardShell view="dashboard" />;
  if (path.endsWith("/design-preview") || path.endsWith("/preview")) return <DashboardShell view="design-preview" />;
  return <ShellApp />;
}

function ShellApp() {
  const theme = useShellStore(selectTheme);
  const selection = useShellStore((s) => s.selection);
  const setSurface = useShellStore((s) => s.setSurface);
  useEffect(() => {
    const persistedSurface = selection.surface as string;
    if (persistedSurface === "beads") setSurface("console");
  }, [selection.surface, setSurface]);
  useGithubActivity({ includeLists: false });
  useRepoTree();
  return (
    <div className="ide-shell" data-theme={theme}>
      <TopBar />
      <div className="ide-body">
        <Sidebar />
        <MainPane />
        <BeadSideDrawer />
      </div>
    </div>
  );
}

function DashboardShell({ view }: { view: View }) {
  const [activeTab, setActiveTab] = useState<Tab>("github");
  const isPreview = view === "design-preview";
  useRepoTree(); // forge-5w9.3 — aggregates github + beads into shell store

  return (
    <div className={isPreview ? "westworld-app design-preview-container" : "westworld-app"} style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', minWidth: 0, background: 'var(--surface-primary)', color: 'var(--text-primary)', fontFamily: 'var(--font-ui)' }}>
      <header className="ww-topbar" style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '0 16px',
        height: 'var(--topbar-height)',
        background: 'var(--surface-secondary)',
        borderBottom: '1px solid var(--border-subtle)',
        flexShrink: 0,
      }}>
        <a
          href="/gitboard"
          style={{ fontSize: 'var(--text-xs)', fontWeight: 600, letterSpacing: '0.1em', color: 'var(--text-muted)', textTransform: 'none', textDecoration: 'none' }}
        >
          xtrm.wtf
        </a>
        <nav className="ww-nav" style={{ display: 'flex', gap: 2, height: '100%', alignItems: 'stretch' }}>
          {TABS.map(tab => (
            <button
              key={tab.id}
              className={activeTab === tab.id && !isPreview ? "ww-nav-item is-active" : "ww-nav-item"}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: '0 10px',
                fontSize: 'var(--text-base)',
                fontWeight: 500,
                color: activeTab === tab.id && !isPreview ? 'var(--text-primary)' : 'var(--text-secondary)',
                background: 'transparent',
                border: 'none',
                borderBottom: activeTab === tab.id && !isPreview ? '2px solid var(--accent-blue)' : '2px solid transparent',
                cursor: 'pointer',
                transition: 'var(--transition)',
              }}
            >
              {tab.label}
            </button>
          ))}
          <a
            href="/gitboard/design-preview"
            className={isPreview ? "ww-nav-item is-active" : "ww-nav-item"}
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '0 12px',
              fontSize: 'var(--text-base)',
              fontWeight: 500,
              color: isPreview ? 'var(--text-primary)' : 'var(--text-secondary)',
              textDecoration: 'none',
              borderBottom: isPreview ? '2px solid var(--accent-purple)' : '2px solid transparent',
              transition: 'var(--transition)',
            }}
          >
            Design Preview
          </a>
        </nav>
        <div className="ww-action-cluster" style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="ww-system-state"><i /> operational</span>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            Beadboard retired
          </span>
        </div>
      </header>
      <main className="gitboard-main" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
        {isPreview ? (
          <DesignPreview />
        ) : activeTab === "github" ? (
          <GithubPanel />
        ) : activeTab === "console" ? (
          <div style={{ padding: 16 }}>
            <SourcesPanel />
          </div>
        ) : null}
      </main>
    </div>
  );
}

const SYSTEMS = [
  { name: "Agent mesh", value: "1,284", delta: "+18", state: "Nominal" },
  { name: "Inference lanes", value: "97.2%", delta: "-0.4", state: "Stable" },
  { name: "Risk envelope", value: "0.032", delta: "+0.006", state: "Guarded" },
  { name: "Deploy queue", value: "42", delta: "7 held", state: "Review" },
];

const TRACE_LINES = [
  "22:51:08.194  policy.kernel    accepted route=autonomy/eu-west trust=0.982",
  "22:51:09.031  fabric.scheduler assigned shard=tx-17 lane=blue-03 latency=14ms",
  "22:51:10.448  sentinel         anomaly score=0.071 class=benign drift=low",
  "22:51:11.206  deploy.ctrl      staged build a91f4c into canary ring-2",
  "22:51:12.713  event.bus        replicated 18,402 packets across backbone",
  "22:51:13.005  model.router     throttled agent cluster varuna-6 by 3.2%",
  "22:51:14.447  guardrail.soc    session attested enclave=blue operator=xtrm",
  "22:51:15.018  market.bridge    pricing stream normalized packets=7,442",
];

const NODES = [
  { label: "intake", x: 14, y: 24, tone: "calm" },
  { label: "policy", x: 38, y: 16, tone: "hot" },
  { label: "orch", x: 58, y: 34, tone: "calm" },
  { label: "model", x: 32, y: 58, tone: "calm" },
  { label: "edge", x: 78, y: 54, tone: "warn" },
  { label: "audit", x: 60, y: 76, tone: "calm" },
];

const FEED = [
  { type: "deploy", title: "Canary ring accepted new autonomy build", repo: "infra/orchestrator", time: "2m ago", status: "verified" },
  { type: "policy", title: "Guardrail threshold revised for EU West", repo: "policy/kernel", time: "6m ago", status: "review" },
  { type: "trace", title: "Agent cluster varuna-6 completed rebalancing", repo: "agents/fabric", time: "11m ago", status: "nominal" },
  { type: "security", title: "Secure enclave attestation refreshed", repo: "sentinel/soc", time: "18m ago", status: "verified" },
  { type: "market", title: "Packet normalization spike contained", repo: "market/bridge", time: "24m ago", status: "guarded" },
  { type: "model", title: "Inference lane blue-03 latency regression cleared", repo: "model/router", time: "31m ago", status: "nominal" },
];

function DesignPreview() {
  return (
    <section className="fui-shell fui-dense">
      <div className="fui-atmosphere" />
      <div className="fui-grid" />

      <aside className="fui-panel fui-rail">
        <PanelTitle kicker="Control" title="Perimeter" />
        {['North Atlantic', 'EU West', 'Pacific Relay', 'Market Core', 'Autonomy Lab', 'SOC Sentinel'].map((region, index) => (
          <button className={index === 1 ? 'fui-region is-active' : 'fui-region'} key={region}>
            <span>{region}</span>
            <small>{index === 2 ? 'Degraded' : index === 5 ? 'Armed' : 'Nominal'}</small>
          </button>
        ))}
        <div className="fui-divider" />
        <PanelTitle kicker="Health" title="State vector" compact />
        <div className="fui-security-ring">
          <span>0.982</span>
          <small>trust index</small>
        </div>
        <div className="fui-mini-stack">
          <span><b />Risk envelope <strong>Low</strong></span>
          <span><b />Packet loss <strong>0.04%</strong></span>
          <span><b />SOC state <strong>Clean</strong></span>
        </div>
      </aside>

      <main className="fui-feed-column">
        <div className="fui-command-bar">
          <div>
            <p className="fui-eyebrow">Autonomous systems operations</p>
            <h1>Critical infrastructure command fabric</h1>
          </div>
          <div className="fui-status-cluster" aria-label="system status">
            <span className="fui-pulse" />
            <span>Live secure session</span>
            <strong>22:51:14 UTC</strong>
          </div>
        </div>

        <section className="fui-metrics">
          {SYSTEMS.map(system => <MetricCard key={system.name} {...system} />)}
        </section>

        <section className="fui-panel fui-activity-panel">
          <div className="fui-tabbar">
            <button className="is-active">Operations</button>
            <button>Deployments</button>
            <button>Security</button>
            <button>Telemetry</button>
          </div>
          <div className="fui-feed-list">
            {FEED.map(item => (
              <article className="fui-feed-item" key={item.title}>
                <div className={`fui-event-dot ${item.status}`} />
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.repo}</span>
                </div>
                <em>{item.type}</em>
                <time>{item.time}</time>
              </article>
            ))}
          </div>
        </section>
      </main>

      <aside className="fui-panel fui-detail-panel">
        <div className="fui-panel-header">
          <PanelTitle kicker="Topology" title="Orchestration map" />
          <div className="fui-chip">Ring 2 · canary</div>
        </div>
        <div className="fui-topology" aria-label="procedural topology diagram">
          <svg className="fui-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
            <path d="M14 24 L38 16 L58 34 L78 54 L60 76 L32 58 L14 24" />
            <path d="M38 16 L32 58 L58 34 L60 76" />
            <path d="M14 24 L58 34 L32 58" />
          </svg>
          {NODES.map(node => (
            <div className={`fui-node ${node.tone}`} style={{ left: `${node.x}%`, top: `${node.y}%` }} key={node.label}>
              <span />
              {node.label}
            </div>
          ))}
        </div>

        <div className="fui-divider" />
        <PanelTitle kicker="Diagnostics" title="Execution trace" />
        <div className="fui-log-stream">
          {TRACE_LINES.map(line => <code key={line}>{line}</code>)}
        </div>
        <div className="fui-pipeline">
          {['Source', 'Verify', 'Stage', 'Canary', 'Promote'].map((step, index) => (
            <div className={index < 3 ? 'is-complete' : index === 3 ? 'is-current' : ''} key={step}>
              <span />
              <small>{step}</small>
            </div>
          ))}
        </div>
      </aside>
    </section>
  );
}

function PanelTitle({ kicker, title, compact = false }: { kicker: string; title: string; compact?: boolean }) {
  return (
    <div className={compact ? "fui-title compact" : "fui-title"}>
      <span>{kicker}</span>
      <h2>{title}</h2>
    </div>
  );
}

function MetricCard({ name, value, delta, state }: { name: string; value: string; delta: string; state: string }) {
  return (
    <article className="fui-panel fui-metric-card">
      <span>{name}</span>
      <strong>{value}</strong>
      <div>
        <small>{delta}</small>
        <em>{state}</em>
      </div>
    </article>
  );
}

function routeTab(path: string): TabId | null {
  if (path.includes("/beads/triage")) return "triage";
  if (path.includes("/beads/memories")) return "memories";
  if (path.includes("/beads/feed") || path.endsWith("/beads")) return "feed";
  if (path.includes("/console/graph")) return "graph";
  if (path.includes("/console/specialists")) return "specialists";
  if (path.includes("/console/observability")) return "observability";
  if (path.endsWith("/console")) return "observability";
  return null;
}
