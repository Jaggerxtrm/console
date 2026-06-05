import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useObservabilitySummary } from "../../hooks/useObservabilitySummary.ts";
import { ShellProviderNotice } from "../../components/console/ShellProviderNotice.tsx";
import type { ShellProviderStatus } from "../../../core/shell-provider-policy.ts";

export function Observability() {
  const [range, setRange] = useState<"7d" | "30d" | "all">("7d");
  const data = useObservabilitySummary(range);
  const tools = data?.toolUsage.totals ?? [];
  const [status, setStatus] = useState<ShellProviderStatus | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/console/shell/status", { signal: controller.signal })
      .then((res) => res.json())
      .then((payload: ShellProviderStatus) => setStatus(payload))
      .catch(() => setStatus(null));
    return () => controller.abort();
  }, []);

  return (
    <section style={shellStyle}>
      {status ? <ShellProviderNotice status={status} /> : null}
      <div style={toggleWrapStyle}>
        {(["7d", "30d", "all"] as const).map((item) => (
          <button key={item} type="button" onClick={() => setRange(item)} style={range === item ? activeToggleStyle : toggleStyle}>{item}</button>
        ))}
      </div>

      <MetricTable title="1. Tokens" columns={["Specialist", "Input", "Output", "Cache create", "Cache read", "Total"]} rows={(data?.tokens.bySpecialist ?? []).map((row) => [row.specialist, row.input, row.output, row.cacheCreation, row.cacheRead, row.total])} />
      <MetricTable title="2. Cache hit rate" columns={["Specialist", "Hit rate"]} rows={(data?.cacheHitRate.bySpecialist ?? []).map((row) => [row.specialist, pct(row.hitRate)])} />
      <MetricTable title="3. Per-specialist averages" columns={["Specialist", "Avg tokens", "Avg elapsed ms", "Avg turns", "Avg tools"]} rows={(data?.averages ?? []).map((row) => [row.specialist, row.avgTokens, row.avgElapsedMs, row.avgTurns, row.avgTools])} />
      <MetricTable title="4. Active runtime" columns={["Specialist", "ms"]} rows={(data?.activeRuntime.bySpecialist ?? []).map((row) => [row.specialist, row.ms])} />
      <MetricTable title="5. Reliability" columns={["Specialist", "Done", "Error", "Cancelled", "Stale warnings"]} rows={(data?.reliability ?? []).map((row) => [row.specialist, row.done, row.error, row.cancelled, row.staleWarnings])} />
      <MetricTable title="6. Slowest jobs" columns={["Job", "Specialist", "Bead", "Model", "Elapsed ms", "Turns", "Tools"]} rows={(data?.slowestJobs ?? []).map((row) => [row.jobId, row.specialist, row.beadId, row.model, row.elapsedMs, row.turns, row.tools])} />
      <MetricTable title="7. Tool usage" columns={["Tool", "Count"]} rows={tools.map((row) => [row.tool, row.count])} />
      <MetricTable title="8. Reviewer outcomes" columns={["PASS", "PARTIAL", "FAIL", "Unknown"]} rows={data ? [[data.reviewerOutcomes.pass, data.reviewerOutcomes.partial, data.reviewerOutcomes.fail, data.reviewerOutcomes.unknown]] : []} />
      <MetricTable title="9. Context burn" columns={["Specialist", "Avg final context %"]} rows={(data?.contextBurn ?? []).map((row) => [row.specialist, pct(row.avgFinalContextPct / 100)])} />
      <MetricTable title="10. Stalls" columns={["Specialist", "Total ms", "Stale warnings"]} rows={(data?.stalls.bySpecialist ?? []).map((row) => [row.specialist, row.totalMs, row.staleWarnings])} />
      <MetricTable title="11. Chains" columns={["Bucket", "Count"]} rows={(data?.chains.lengthHistogram ?? []).map((row) => [row.bucket, row.count])} />
    </section>
  );
}

function MetricTable({ title, columns, rows }: { title: string; columns: Array<string>; rows: Array<Array<string | number>> }) {
  const widths = useMemo(() => columns.map(() => 1 / columns.length), [columns.length]);
  return (
    <section style={sectionStyle}>
      <div style={tableStyle}>
        <div style={rowStyle}>
          {columns.map((col, i) => <Cell key={col} value={col} header width={widths[i]} />)}
        </div>
        {rows.map((row, index) => (
          <div key={`${title}-${index}`} style={rowStyle}>
            {row.map((value, i) => <Cell key={`${title}-${index}-${i}`} value={value} width={widths[i]} />)}
          </div>
        ))}
      </div>
    </section>
  );
}

function Cell({ value, header = false, width = 1 }: { value: string | number; header?: boolean; width?: number }) {
  const mono = isNumeric(value);
  return <div style={{ ...cellStyle, width: `${width * 100}%`, fontWeight: header ? 600 : 400, fontFamily: mono ? "JetBrains Mono, monospace" : "Inter, sans-serif" }}>{String(value)}</div>;
}

function pct(value: number) { return `${Math.round(value * 100)}%`; }
function isNumeric(value: string | number) { return typeof value === "number" || /^\d/.test(String(value)); }

const shellStyle: CSSProperties = { background: "var(--surface-primary)", color: "var(--text-primary)", fontFamily: "Inter, sans-serif" };
const toggleWrapStyle: CSSProperties = { display: "flex", gap: 8, marginBottom: 12 };
const toggleStyle: CSSProperties = { background: "transparent", color: "var(--text-muted)", border: "none", borderBottom: "1px solid transparent", padding: "4px 0", fontFamily: "JetBrains Mono, monospace" };
const activeToggleStyle: CSSProperties = { ...toggleStyle, color: "var(--text-primary)", borderBottomColor: "var(--accent)" };
const sectionStyle: CSSProperties = { borderTop: "1px solid var(--border-subtle)", paddingTop: 12, marginTop: 12 };
const tableStyle: CSSProperties = { display: "grid", gap: 0, border: "1px solid var(--border-subtle)", marginTop: 8 };
const rowStyle: CSSProperties = { display: "flex" };
const cellStyle: CSSProperties = { padding: "6px 8px", borderRight: "1px solid var(--border-subtle)", borderBottom: "1px solid var(--border-subtle)", fontSize: 12, minWidth: 0 };
