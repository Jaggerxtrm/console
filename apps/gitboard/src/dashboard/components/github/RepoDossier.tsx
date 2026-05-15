import { useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  BookIcon,
  FileBadgeIcon,
  HistoryIcon,
  XIcon,
  LinkExternalIcon,
} from "@primer/octicons-react";
import { ReadmeView, ChangelogView, ReportsView, parseOwnerName } from "./RepoContentPanels.tsx";
import { apiClient } from "../../lib/client.ts";

type Tab = "readme" | "changelog" | "reports";

interface Props {
  repo: string;
  onClose: () => void;
}

export function RepoDossier({ repo, onClose }: Props) {
  const parsed = parseOwnerName(repo);
  const [tab, setTab] = useState<Tab>("readme");
  const [reportCount, setReportCount] = useState<number | null>(null);

  const closeOnEscape = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  }, [onClose]);

  useEffect(() => {
    document.addEventListener("keydown", closeOnEscape);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = prev;
    };
  }, [closeOnEscape]);

  useEffect(() => {
    if (!parsed) return;
    let alive = true;
    apiClient
      .listRepoReports(parsed.owner, parsed.name)
      .then((res) => alive && setReportCount(res.data.length))
      .catch(() => alive && setReportCount(0));
    return () => {
      alive = false;
    };
  }, [parsed?.owner, parsed?.name]);

  if (!parsed) return null;

  const tabs: { id: Tab; label: string; Icon: React.ElementType; count?: number | null }[] = [
    { id: "readme", label: "README", Icon: BookIcon },
    { id: "changelog", label: "CHANGELOG", Icon: FileBadgeIcon },
    { id: "reports", label: "Reports", Icon: HistoryIcon, count: reportCount },
  ];

  return createPortal(
    <div className="repo-dossier-backdrop" onClick={onClose}>
      <div className="repo-dossier-panel" onClick={(e) => e.stopPropagation()}>
        <header className="repo-dossier-header">
          <div className="repo-dossier-title">
            <span className="repo-dossier-name">{repo}</span>
            <a
              href={`https://github.com/${repo}`}
              target="_blank"
              rel="noreferrer"
              className="repo-dossier-link"
              title="Open on GitHub"
            >
              <LinkExternalIcon size={12} />
            </a>
          </div>
          <button className="repo-dossier-close" onClick={onClose} aria-label="Close">
            <XIcon size={14} />
          </button>
        </header>

        <nav className="repo-dossier-tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`repo-dossier-tab ${tab === t.id ? "is-active" : ""}`}
              onClick={() => setTab(t.id)}
              type="button"
            >
              <t.Icon size={12} />
              <span>{t.label}</span>
              {t.count != null ? <span className="repo-dossier-tab-count">{t.count}</span> : null}
            </button>
          ))}
        </nav>

        <div className="repo-dossier-content">
          {tab === "readme" && <ReadmeView owner={parsed.owner} name={parsed.name} />}
          {tab === "changelog" && <ChangelogView owner={parsed.owner} name={parsed.name} />}
          {tab === "reports" && <ReportsView owner={parsed.owner} name={parsed.name} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}
