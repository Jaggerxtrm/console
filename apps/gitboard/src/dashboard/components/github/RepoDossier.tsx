import { useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  BookIcon,
  FileBadgeIcon,
  HistoryIcon,
  XIcon,
  LinkExternalIcon,
} from "@primer/octicons-react";
import { apiClient } from "../../lib/client.ts";
import { renderPrBodyText } from "./PrTimeline.tsx";

type Tab = "readme" | "changelog" | "reports";

interface Props {
  repo: string;
  onClose: () => void;
}

function parseOwnerName(full: string): { owner: string; name: string } | null {
  const [owner, name] = full.split("/");
  if (!owner || !name) return null;
  return { owner, name };
}

export function RepoDossier({ repo, onClose }: Props) {
  const parsed = parseOwnerName(repo);
  const [tab, setTab] = useState<Tab>("readme");
  const [readme, setReadme] = useState<string | null | "loading" | "error">("loading");
  const [changelog, setChangelog] = useState<string | null | "loading" | "error">("loading");
  const [reports, setReports] = useState<{ name: string; path: string; sha: string }[] | "loading" | "error">("loading");
  const [openReport, setOpenReport] = useState<string | null>(null);
  const [reportBody, setReportBody] = useState<string | "loading" | "error">("loading");

  const closeOnEscape = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  }, [onClose]);

  useEffect(() => {
    document.addEventListener("keydown", closeOnEscape);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = prevOverflow;
    };
  }, [closeOnEscape]);

  useEffect(() => {
    if (!parsed) return;
    let alive = true;
    apiClient
      .getRepoMarkdown(parsed.owner, parsed.name, "README.md")
      .then((res) => alive && setReadme(res.content))
      .catch(() => alive && setReadme("error"));
    apiClient
      .getRepoMarkdown(parsed.owner, parsed.name, "CHANGELOG.md")
      .then((res) => alive && setChangelog(res.content))
      .catch(() => alive && setChangelog("error"));
    apiClient
      .listRepoReports(parsed.owner, parsed.name)
      .then((res) => alive && setReports(res.data))
      .catch(() => alive && setReports("error"));
    return () => {
      alive = false;
    };
  }, [parsed?.owner, parsed?.name]);

  useEffect(() => {
    if (!parsed || !openReport) return;
    let alive = true;
    setReportBody("loading");
    apiClient
      .getRepoReport(parsed.owner, parsed.name, openReport)
      .then((res) => alive && setReportBody(res.content))
      .catch(() => alive && setReportBody("error"));
    return () => {
      alive = false;
    };
  }, [parsed?.owner, parsed?.name, openReport]);

  if (!parsed) return null;

  const tabs: { id: Tab; label: string; Icon: React.ElementType; count?: number }[] = [
    { id: "readme", label: "README", Icon: BookIcon },
    { id: "changelog", label: "CHANGELOG", Icon: FileBadgeIcon },
    { id: "reports", label: "Reports", Icon: HistoryIcon, count: Array.isArray(reports) ? reports.length : undefined },
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
          {tab === "readme" && <MarkdownPane content={readme} emptyLabel="No README.md in this repo." />}
          {tab === "changelog" && <MarkdownPane content={changelog} emptyLabel="No CHANGELOG.md in this repo." />}
          {tab === "reports" && (
            <ReportsPane
              reports={reports}
              openReport={openReport}
              setOpenReport={setOpenReport}
              reportBody={reportBody}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function MarkdownPane({ content, emptyLabel }: { content: string | null | "loading" | "error"; emptyLabel: string }) {
  if (content === "loading") return <div className="repo-dossier-state">Loading…</div>;
  if (content === "error") return <div className="repo-dossier-state">Failed to load.</div>;
  if (!content) return <div className="repo-dossier-state">{emptyLabel}</div>;
  return (
    <div className="pr-body-text">
      <div className="pr-rich-text">{renderPrBodyText(content)}</div>
    </div>
  );
}

function ReportsPane({
  reports,
  openReport,
  setOpenReport,
  reportBody,
}: {
  reports: { name: string; path: string; sha: string }[] | "loading" | "error";
  openReport: string | null;
  setOpenReport: (name: string | null) => void;
  reportBody: string | "loading" | "error";
}) {
  if (reports === "loading") return <div className="repo-dossier-state">Loading…</div>;
  if (reports === "error") return <div className="repo-dossier-state">Failed to load reports.</div>;
  if (reports.length === 0)
    return <div className="repo-dossier-state">No reports yet — push to .xtrm/reports/ in this repo.</div>;

  return (
    <div className="repo-dossier-reports">
      <ul className="repo-dossier-report-list">
        {reports.map((r) => (
          <li key={r.sha}>
            <button
              type="button"
              className={`repo-dossier-report-row ${openReport === r.name ? "is-active" : ""}`}
              onClick={() => setOpenReport(openReport === r.name ? null : r.name)}
            >
              <span className="repo-dossier-report-name">{r.name}</span>
            </button>
            {openReport === r.name && (
              <div className="repo-dossier-report-body">
                {reportBody === "loading" && <div className="repo-dossier-state">Loading…</div>}
                {reportBody === "error" && <div className="repo-dossier-state">Failed to load report.</div>}
                {typeof reportBody === "string" && reportBody !== "loading" && reportBody !== "error" && (
                  <div className="pr-body-text">
                    <div className="pr-rich-text">{renderPrBodyText(reportBody)}</div>
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
