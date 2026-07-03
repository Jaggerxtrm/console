import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "@primer/octicons-react";
import type { BeadIssueDetail } from "../../../types/beads.ts";
import { useBeadSideDrawer } from "../../hooks/useBeadSideDrawer.ts";
import { substrateApi } from "../../lib/beads.ts";
import { useShellStore } from "../../stores/shell.ts";
import { useSpecialistOwnership } from "../../hooks/useSpecialistOwnership.ts";
import { useSpecialistHistory } from "../../hooks/useSpecialistHistory.ts";
import { IssueDossier } from "../../components/beads/IssueFeed.tsx";

export function BeadSideDrawer({ onClose }: { onClose?: () => void } = {}) {
  const beadId = useBeadSideDrawer((s) => s.beadId);
  const projectId = useBeadSideDrawer((s) => s.projectId);
  const issueById = useBeadSideDrawer((s) => s.issueById);
  const close = useBeadSideDrawer((s) => s.close);
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
    void substrateApi.getIssue(projectId, beadId).then((next) => {
      if (!cancelled) setDetail(next);
    }).catch(() => {
      if (!cancelled) setDetail(null);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [beadId, projectId]);

  const handleClose = useCallback(() => {
    onClose?.();
    close();
  }, [close, onClose]);

  const handleKey = useCallback((event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      handleClose();
    }
  }, [handleClose]);

  useEffect(() => {
    if (!beadId) return;
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
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
    <div className="bead-side-drawer-backdrop" aria-hidden="false">
      <aside className="bead-side-drawer" role="complementary" aria-label="Issue inspector">
        <header className="bead-side-drawer-header">
          <div className="bead-side-drawer-header-main">
            <div className="bead-side-drawer-breadcrumb" aria-label={`xtrm / issue / ${issue.id}`}>
              <span>xtrm</span>
              <span>/</span>
              <span>issue</span>
              <span>/</span>
              <span>{issue.id}</span>
            </div>
            <div className="bead-side-drawer-headline">
              <span className="bead-side-drawer-id">{issue.id}</span>
              <span id="bead-side-drawer-title" className="bead-side-drawer-title">{issue.title}</span>
            </div>
          </div>
          <button type="button" className="bead-side-drawer-close" aria-label="close bead drawer" onClick={handleClose}><XIcon size={14} /></button>
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
          <button type="button" className="ide-btn" onClick={goToFeed}>Open in Issues</button>
        </footer>
      </aside>
    </div>,
    document.body,
  );
}
