import type { ChainSummary } from "../../../hooks/useChains.ts";
import type { ChainIssueContext } from "./chainIssueContext.ts";
import { IssueContextChip } from "./IssueContextChip.tsx";

const STATUS_PALETTE: Record<string, { fg: string; bg: string }> = {
  starting: { fg: "var(--graph-state-wip)", bg: "rgba(212, 161, 89, 0.10)" },
  running: { fg: "var(--graph-state-wip)", bg: "rgba(212, 161, 89, 0.10)" },
  waiting: { fg: "var(--text-muted)", bg: "rgba(255, 255, 255, 0.04)" },
  done: { fg: "var(--graph-state-closed)", bg: "rgba(72, 159, 110, 0.10)" },
  error: { fg: "var(--graph-priority-0)", bg: "rgba(217, 95, 81, 0.10)" },
  failed: { fg: "var(--graph-priority-0)", bg: "rgba(217, 95, 81, 0.10)" },
  cancelled: { fg: "var(--text-muted)", bg: "rgba(255, 255, 255, 0.04)" },
};

export function ChainListRow({ chain, issueContext }: { chain: ChainSummary; issueContext?: ChainIssueContext }) {
  const roles = chain.roles.map((item) => item.role).join(", ") || "unknown";
  const latestJob = chain.jobs[chain.jobs.length - 1];
  const palette = STATUS_PALETTE[chain.status] ?? STATUS_PALETTE.done;
  const contextItems = issueContext ? [
    ...issueContext.touched.map((node) => ({ key: `touched:${node.id}`, node, relation: "touched" as const })),
    ...issueContext.related.map((item) => ({
      key: `${item.edge.type}:${item.direction}:${item.node.id}`,
      node: item.node,
      relation: item.edge.type,
    })),
  ].slice(0, 3) : [];
  const hiddenContextCount = issueContext ? Math.max(0, issueContext.touched.length + issueContext.related.length - contextItems.length) : 0;

  return (
    <div className="console-specialists-chain-row">
      <div className="console-specialists-chain-row-identity">
        <span className="console-specialists-chain-row-id">{chain.rootBeadId}</span>
        <span className="console-specialists-chain-row-sep">/</span>
        <span className="console-specialists-chain-row-title">{chain.title}</span>
      </div>
      <div className="console-specialists-chain-row-meta">
        <span className="console-specialists-chain-row-chip" style={{ color: palette.fg, background: palette.bg }}>
          <span className="console-specialists-chain-row-chip-dot" />
          <span>{chain.status}</span>
        </span>
        <span className="console-specialists-chain-row-roles">{roles}</span>
        <span className="console-specialists-chain-row-sep">/</span>
        <span className="console-specialists-chain-row-job">{latestJob?.jobId ?? chain.chainId}</span>
      </div>
      {contextItems.length > 0 ? (
        <div className="console-specialists-chain-row-context">
          {contextItems.map((item) => <IssueContextChip key={item.key} node={item.node} relation={item.relation} />)}
          {hiddenContextCount > 0 ? <span className="spec-issue-chip-more">+{hiddenContextCount}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
