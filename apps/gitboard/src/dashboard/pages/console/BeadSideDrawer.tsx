import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "@primer/octicons-react";
import type { BeadIssueDetail } from "../../../types/beads.ts";
import { useBeadSideDrawer } from "../../hooks/useBeadSideDrawer.ts";
import { beadsApi } from "../../lib/beads-api.ts";
import { useShellStore } from "../../stores/shell.ts";
import { useSpecialistOwnership } from "../../hooks/useSpecialistOwnership.ts";
import { useSpecialistHistory } from "../../hooks/useSpecialistHistory.ts";
import { IssueDossier } from "../../components/beads/IssueFeed.tsx";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function BeadSideDrawer({ onClose }: { onClose?: () => void } = {}) {
  const beadId = useBeadSideDrawer((s) => s.beadId);
  const projectId = useBeadSideDrawer((s) => s.projectId);
  const issueById = useBeadSideDrawer((s) => s.issueById);
  const close = useBeadSideDrawer((s) => s.close);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const issue = beadId ? issueById.get(beadId) ?? null : null;
  const ownership = useSpecialistOwnership(beadId);
  const history = useSpecialistHistory(beadId);
  const [detail, setDetail] = useState<BeadIssueDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!beadId || !projectId) {
      setDetail(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    void beadsApi.getIssue(projectId, beadId).then((next) => {
      if (!cancelled) setDetail(next);
    }).catch(() => {
      if (!cancelled) setDetail(null);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [beadId, projectId]);

  const handleKey = useCallback((event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose?.();
      close();
      return;
    }
    if (event.key !== "Tab" || !panelRef.current) return;
    const items = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, [close]);

  useEffect(() => {
    if (!beadId) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    document.addEventListener("keydown", handleKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    queueMicrotask(() => panelRef.current?.focus());
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocused.current?.focus?.();
    };
  }, [beadId, handleKey]);

  const goToFeed = useCallback(() => {
    const shell = useShellStore.getState();
    shell.setSurface("console");
    shell.setTab("feed");
    close();
    queueMicrotask(() => document.querySelector(`[data-bead-id="${CSS.escape(beadId ?? "")}"]`)?.scrollIntoView({ block: "center" }));
  }, [beadId, close]);

  if (!beadId || !issue) return null;

  return createPortal(
    <div className="bead-side-drawer-backdrop" onClick={() => { onClose?.(); close(); }}>
      <aside className="bead-side-drawer" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="bead-side-drawer-title" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <header className="bead-side-drawer-header">
          <div className="bead-side-drawer-headline">
            <span className="bead-side-drawer-id">{issue.id}</span>
            <span id="bead-side-drawer-title" className="bead-side-drawer-title">{issue.title}</span>
          </div>
          <button type="button" className="bead-side-drawer-close" aria-label="close bead drawer" onClick={() => { onClose?.(); close(); }}><XIcon size={14} /></button>
        </header>
        <div className="bead-side-drawer-body">
          <div className="bead-dossier-meta-strip">
            <span><b>Priority</b><strong>P{issue.priority}</strong></span>
            <span><b>Type</b><strong>{String(issue.issue_type)}</strong></span>
            <span><b>Status</b><strong>{issue.status}</strong></span>
            {ownership && <span><b>Owner</b><strong>{ownership.role}</strong></span>}
            {history.count > 0 && <span><b>History</b><strong>{history.count} run{history.count === 1 ? "" : "s"}</strong></span>}
          </div>
          <IssueDossier id={`bead-side-drawer-${issue.id}`} issue={issue} detail={detail} loading={loading} projectId={projectId} issueById={issueById} />
        </div>
        <footer className="bead-side-drawer-footer">
          <button type="button" className="ide-btn" onClick={goToFeed}>Open in Feed</button>
        </footer>
      </aside>
    </div>,
    document.body,
  );
}
