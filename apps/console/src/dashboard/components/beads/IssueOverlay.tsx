import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "@primer/octicons-react";
import type { BeadIssue, BeadIssueDetail } from "../../../types/beads.ts";
import { IssueDossier } from "./IssueFeed.tsx";
import { SpecialistChainGraph } from "./SpecialistChainGraph.tsx";

interface IssueOverlayProps {
  issue: BeadIssue;
  detail: BeadIssueDetail | null;
  loading: boolean;
  projectId: string | null;
  issueById: Map<string, BeadIssue>;
  onClose: () => void;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function IssueOverlay({ issue, detail, loading, projectId, issueById, onClose }: IssueOverlayProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !panelRef.current) return;
    const items = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, [onClose]);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    document.addEventListener("keydown", handleKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    queueMicrotask(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panelRef.current)?.focus();
    });
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocused.current?.focus?.();
    };
  }, [handleKey]);

  return createPortal(
    <div className="bead-overlay-backdrop" onClick={onClose}>
      <div
        className="bead-overlay-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bead-overlay-heading"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="bead-overlay-header">
          <span id="bead-overlay-heading" className="bead-overlay-id">{issue.id}</span>
          <button className="bead-overlay-close" onClick={onClose} aria-label="Close">
            <XIcon size={14} />
          </button>
        </header>
        <div className="bead-overlay-content">
          <SpecialistChainGraph beadId={issue.id} />
          <IssueDossier
            id={`bead-overlay-${issue.id}`}
            issue={issue}
            detail={detail}
            loading={loading}
            projectId={projectId}
            issueById={issueById}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
