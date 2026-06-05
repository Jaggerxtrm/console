import { useMemo, useState } from "react";
import type { SpecialistChain } from "../../../types/specialists.ts";
import { useChain } from "./useChain.ts";

const CHAIN_ORDER: Record<string, number> = {
  explorer: 0,
  executor: 1,
  reviewer: 2,
  fix: 3,
};

function truncateExcerpt(value: string | null | undefined): string {
  const text = value?.trim() ?? "";
  if (text.length <= 120) return text;
  return `${text.slice(0, 117)}…`;
}

function getLabel(job: SpecialistChain): string {
  const specialist = job.chainKind ?? "unknown";
  return `${specialist} · ${job.status}`;
}

export function SpecialistChainGraph({ beadId }: { beadId: string | null }) {
  const { chain } = useChain(beadId);
  const [hovered, setHovered] = useState<string | null>(null);

  const ordered = useMemo(() => {
    if (!chain) return null;
    return [...chain].sort((a, b) => {
      const aRank = CHAIN_ORDER[a.chainKind ?? ""] ?? 99;
      const bRank = CHAIN_ORDER[b.chainKind ?? ""] ?? 99;
      if (aRank !== bRank) return aRank - bRank;
      return a.updatedAt.localeCompare(b.updatedAt);
    });
  }, [chain]);

  if (!ordered || ordered.length === 0) return null;

  return (
    <div className="bead-chain-graph" role="list" aria-label="Specialist chain">
      {ordered.map((job, index) => {
        const excerpt = truncateExcerpt((job as SpecialistChain & { lastOutput?: string | null }).lastOutput ?? (job as SpecialistChain & { last_output?: string | null }).last_output);
        return (
          <div key={`${job.repoSlug}-${job.beadId}`} className="bead-chain-node-wrap">
            <button
              type="button"
              className="bead-chain-node"
              role="listitem"
              title={excerpt || undefined}
              onMouseEnter={() => setHovered(job.beadId)}
              onMouseLeave={() => setHovered((curr) => (curr === job.beadId ? null : curr))}
            >
              <span className="bead-chain-node-label">{getLabel(job)}</span>
              <span className="bead-chain-node-id">{job.beadId}</span>
            </button>
            {hovered === job.beadId && excerpt ? (
              <div className="bead-chain-tooltip" role="tooltip">
                {excerpt}
              </div>
            ) : null}
            {index < ordered.length - 1 ? <span className="bead-chain-connector" aria-hidden="true">→</span> : null}
          </div>
        );
      })}
    </div>
  );
}
