import { useEffect, useState } from "react";
import { apiClient } from "../../lib/client.ts";
import { renderPrBodyText } from "../../lib/markdown.tsx";

type AsyncContent = string | null | "loading" | "error";

interface ReportEntry {
  name: string;
  path: string;
  sha: string;
  size?: number;
  frontmatter: Record<string, string> | null;
}

export function ReadmeView({ owner, name }: { owner: string; name: string }) {
  return <MarkdownView owner={owner} name={name} path="README.md" emptyLabel="No README.md in this repo." />;
}

export function ChangelogView({ owner, name }: { owner: string; name: string }) {
  return <MarkdownView owner={owner} name={name} path="CHANGELOG.md" emptyLabel="No CHANGELOG.md in this repo." />;
}

function MarkdownView({ owner, name, path, emptyLabel }: { owner: string; name: string; path: string; emptyLabel: string }) {
  const [content, setContent] = useState<AsyncContent>("loading");
  useEffect(() => {
    let alive = true;
    setContent("loading");
    apiClient
      .getRepoMarkdown(owner, name, path)
      .then((res) => alive && setContent(res.content))
      .catch(() => alive && setContent("error"));
    return () => {
      alive = false;
    };
  }, [owner, name, path]);

  if (content === "loading") return <div className="repo-content-state">Loading…</div>;
  if (content === "error") return <div className="repo-content-state">Failed to load.</div>;
  if (!content) return <div className="repo-content-state">{emptyLabel}</div>;
  return (
    <div className="gb-detail-stack">
      <div className="pr-body-text">
        <div className="pr-rich-text">{renderPrBodyText(content)}</div>
      </div>
    </div>
  );
}

export function ReportsView({ owner, name }: { owner: string; name: string }) {
  const [reports, setReports] = useState<ReportEntry[] | "loading" | "error">("loading");
  const [open, setOpen] = useState<string | null>(null);
  const [body, setBody] = useState<AsyncContent>("loading");

  useEffect(() => {
    let alive = true;
    setReports("loading");
    setOpen(null);
    apiClient
      .listRepoReports(owner, name)
      .then((res) => alive && setReports(res.data))
      .catch(() => alive && setReports("error"));
    return () => {
      alive = false;
    };
  }, [owner, name]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setBody("loading");
    apiClient
      .getRepoReport(owner, name, open)
      .then((res) => alive && setBody(res.content))
      .catch(() => alive && setBody("error"));
    return () => {
      alive = false;
    };
  }, [owner, name, open]);

  if (reports === "loading") return <div className="repo-content-state">Loading…</div>;
  if (reports === "error") return <div className="repo-content-state">Failed to load reports.</div>;
  if (reports.length === 0)
    return <div className="repo-content-state">No reports yet — push to .xtrm/reports/ in this repo.</div>;

  return (
    <div className="gb-detail-stack">
      <ul className="repo-report-list">
        {reports.map((r) => (
          <li key={r.sha}>
            <button
              type="button"
              className={`repo-report-row ${open === r.name ? "is-active" : ""}`}
              onClick={() => setOpen(open === r.name ? null : r.name)}
            >
              <span className="repo-report-name">{r.name.replace(/\.md$/, "")}</span>
              <ReportMeta fm={r.frontmatter} />
            </button>
            {open === r.name && (
              <div className="repo-report-body">
                {body === "loading" && <div className="repo-content-state">Loading…</div>}
                {body === "error" && <div className="repo-content-state">Failed to load report.</div>}
                {typeof body === "string" && body !== "loading" && body !== "error" && (
                  <div className="pr-body-text">
                    <div className="pr-rich-text">{renderPrBodyText(body)}</div>
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

function ReportMeta({ fm }: { fm: Record<string, string> | null }) {
  if (!fm) return null;
  const items: Array<[string, string]> = [];
  if (fm.session_date) items.push(["date", fm.session_date]);
  if (fm.branch) items.push(["branch", fm.branch]);
  if (fm.commits) items.push(["commits", fm.commits]);
  if (fm.issues_closed) items.push(["closed", fm.issues_closed]);
  if (fm.issues_filed) items.push(["filed", fm.issues_filed]);
  if (fm.specialist_dispatches) items.push(["dispatch", fm.specialist_dispatches]);
  if (items.length === 0) return null;
  return (
    <span className="repo-report-meta">
      {items.map(([k, v]) => (
        <span key={k} className="repo-report-meta-item">
          <b>{k}</b>
          {v}
        </span>
      ))}
    </span>
  );
}

export function parseOwnerName(full: string): { owner: string; name: string } | null {
  const [owner, name] = full.split("/");
  if (!owner || !name) return null;
  return { owner, name };
}
