import type { HtmlDocumentEntry, PreviewIndex, RepoEntry } from "./types.ts";
import { encodePathSegments, escapeHtml } from "./security.ts";

export function renderIndex(index: PreviewIndex): string {
  const repoOptions = index.repos.map(renderRepoButton).join("");
  const rows = index.documents.map(renderDocumentRow).join("");

  return renderPage({
    title: "HTML Preview",
    body: `
      <div class="ide-shell" data-theme="dark">
        ${renderTopbar(index)}
        <div class="ide-body">
          <aside class="ide-sidebar">
            <div class="ide-sidebar-header">
              <div>
                <div class="ide-sidebar-title">HTML Preview</div>
                <div class="ide-sidebar-count">${index.documents.length} files</div>
              </div>
            </div>
            <div class="ide-sidebar-body">
              <button class="repo-filter is-active" data-repo="all" type="button">All repositories</button>
              ${repoOptions}
            </div>
          </aside>
          <main class="ide-main">
            <section class="module">
              <header class="module-header">
                <div class="module-header-shell">
                  <strong>Documents</strong>
                  <span>${escapeHtml(index.root)}</span>
                </div>
                <form method="post" action="/api/refresh">
                  <button class="ide-btn" type="submit">Refresh</button>
                </form>
              </header>
              <div class="toolbar">
                <input id="search" type="search" placeholder="Filter by title, repo, or path" autocomplete="off" />
                <span class="muted" id="result-count">${index.documents.length} visible</span>
              </div>
              <div class="rows" id="rows">${rows || renderEmptyState()}</div>
            </section>
          </main>
        </div>
      </div>
      ${renderIndexScript()}
    `,
  });
}

export function renderViewer(index: PreviewIndex, document: HtmlDocumentEntry): string {
  const rawPath = `/raw/${encodeURIComponent(document.repoId)}/${encodePathSegments(document.path)}`;
  return renderPage({
    title: `${document.title} - HTML Preview`,
    body: `
      <div class="ide-shell" data-theme="dark">
        ${renderTopbar(index)}
        <div class="viewer-layout">
          <aside class="viewer-meta">
            <a class="back-link" href="/">Back to index</a>
            <div class="viewer-title">${escapeHtml(document.title)}</div>
            <dl>
              <dt>Repository</dt>
              <dd>${escapeHtml(document.repoName)}</dd>
              <dt>Path</dt>
              <dd>${escapeHtml(document.path)}</dd>
              <dt>Modified</dt>
              <dd>${formatDate(document.modifiedAt)}</dd>
            </dl>
            <a class="ide-btn full" href="${rawPath}" target="_blank" rel="noreferrer">Open raw</a>
          </aside>
          <main class="preview-stage">
            <iframe src="${rawPath}" sandbox="allow-forms allow-modals allow-popups allow-scripts allow-same-origin"></iframe>
          </main>
        </div>
      </div>
      ${renderThemeScript()}
    `,
  });
}

export function renderNotFound(message: string): string {
  return renderPage({
    title: "Not found - HTML Preview",
    body: `
      <div class="ide-shell" data-theme="dark">
        <main class="not-found">
          <h1>Not found</h1>
          <p>${escapeHtml(message)}</p>
          <a class="ide-btn" href="/">Back to index</a>
        </main>
      </div>
      ${renderThemeScript()}
    `,
  });
}

function renderPage({ title, body }: { title: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>${styles}</style>
</head>
<body>${body}</body>
</html>`;
}

function renderTopbar(index: PreviewIndex): string {
  return `
    <header class="ide-topbar">
      <div class="brand">
        <span class="brand-mark"></span>
        <span>html-preview</span>
      </div>
      <div class="topbar-meta">Updated ${formatDate(index.generatedAt)}</div>
      <button class="ide-theme-toggle" type="button" aria-label="Toggle theme">
        <span class="ide-theme-track">
          <span class="ide-theme-option ide-theme-option-dark">Dark</span>
          <span class="ide-theme-option ide-theme-option-light">Light</span>
          <span class="ide-theme-thumb"></span>
        </span>
      </button>
    </header>
  `;
}

function renderRepoButton(repo: RepoEntry): string {
  return `<button class="repo-filter" data-repo="${escapeHtml(repo.id)}" type="button">
    <span>${escapeHtml(repo.name)}</span>
    <small>${escapeHtml(repo.relativePath)}</small>
  </button>`;
}

function renderDocumentRow(document: HtmlDocumentEntry): string {
  const viewHref = `/view?repo=${encodeURIComponent(document.repoId)}&path=${encodeURIComponent(document.path)}`;
  return `<a class="row html-row" href="${viewHref}" data-repo="${escapeHtml(document.repoId)}" data-search="${escapeHtml(`${document.title} ${document.repoName} ${document.path}`.toLowerCase())}">
    <span class="row-main">
      <span class="title">${escapeHtml(document.title)}</span>
      <span class="meta">
        <span>${escapeHtml(document.repoName)}</span>
        <span>${escapeHtml(document.path)}</span>
      </span>
    </span>
    <span class="row-side">
      <span>${formatBytes(document.size)}</span>
      <span>${formatDate(document.modifiedAt)}</span>
    </span>
  </a>`;
}

function renderEmptyState(): string {
  return `<div class="empty">No HTML files found under this root.</div>`;
}

function renderIndexScript(): string {
  return `<script>
${themeScript}
const search = document.querySelector("#search");
const rows = Array.from(document.querySelectorAll(".html-row"));
const count = document.querySelector("#result-count");
const filters = Array.from(document.querySelectorAll(".repo-filter"));
let activeRepo = "all";

function applyFilters() {
  const term = (search?.value || "").trim().toLowerCase();
  let visible = 0;
  for (const row of rows) {
    const repoMatches = activeRepo === "all" || row.dataset.repo === activeRepo;
    const textMatches = !term || (row.dataset.search || "").includes(term);
    const show = repoMatches && textMatches;
    row.hidden = !show;
    if (show) visible += 1;
  }
  if (count) count.textContent = visible + " visible";
}

for (const filter of filters) {
  filter.addEventListener("click", () => {
    activeRepo = filter.dataset.repo || "all";
    for (const item of filters) item.classList.toggle("is-active", item === filter);
    applyFilters();
  });
}

search?.addEventListener("input", applyFilters);
</script>`;
}

function renderThemeScript(): string {
  return `<script>${themeScript}</script>`;
}

const themeScript = `
const shell = document.querySelector(".ide-shell");
const savedTheme = localStorage.getItem("xtrm-html-preview-theme") || "dark";
shell?.setAttribute("data-theme", savedTheme);
document.querySelector(".ide-theme-toggle")?.addEventListener("click", () => {
  const next = shell?.getAttribute("data-theme") === "light" ? "dark" : "light";
  shell?.setAttribute("data-theme", next);
  localStorage.setItem("xtrm-html-preview-theme", next);
});
`;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

const styles = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

:root {
  --bg: #101010;
  --surface-1: #101010;
  --surface-2: #141414;
  --surface-3: #1b1b1b;
  --border-subtle: rgba(255, 255, 255, 0.1);
  --border-default: rgba(255, 255, 255, 0.16);
  --text-primary: #e6e6e6;
  --text-secondary: #a7a7a7;
  --text-muted: #757575;
  --accent: #b8b8b8;
  --accent-green: #7fbf8f;
  --font-ui: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --sidebar-width: 260px;
  --topbar-height: 40px;
}

*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body { font-family: var(--font-ui); font-size: 14px; background: var(--bg); color: var(--text-primary); overflow: hidden; }
a { color: inherit; text-decoration: none; }
button, input { font: inherit; }
* { scrollbar-width: thin; scrollbar-color: #333 transparent; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #333; }

.ide-shell {
  min-height: 100vh;
  height: 100vh;
  display: grid;
  grid-template-rows: var(--topbar-height) minmax(0, 1fr);
  background: var(--bg);
  color: var(--text-primary);
}

.ide-shell[data-theme="light"] {
  --bg: #ffffff;
  --surface-1: #ffffff;
  --surface-2: #f6f8fa;
  --surface-3: #eef1f4;
  --border-subtle: rgba(31, 35, 40, 0.12);
  --border-default: rgba(31, 35, 40, 0.18);
  --text-primary: #1f2328;
  --text-secondary: #57606a;
  --text-muted: #6e7781;
  --accent: #24292f;
}

.ide-topbar {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: 14px;
  min-width: 0;
  padding: 0 12px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--surface-1);
}

.brand { display: flex; align-items: center; gap: 8px; min-width: 0; font-weight: 650; }
.brand-mark { width: 9px; height: 9px; background: var(--accent-green); display: inline-block; }
.topbar-meta { color: var(--text-muted); font-size: 12px; white-space: nowrap; }
.ide-body { display: grid; grid-template-columns: var(--sidebar-width) minmax(0, 1fr); min-height: 0; }
.ide-sidebar { min-height: 0; border-right: 1px solid var(--border-subtle); background: var(--surface-1); overflow: auto; }
.ide-sidebar-header { min-height: 56px; display: flex; align-items: center; padding: 0 12px; border-bottom: 1px solid var(--border-subtle); }
.ide-sidebar-title { font-size: 12px; font-weight: 700; }
.ide-sidebar-count { margin-top: 3px; color: var(--text-muted); font-size: 12px; }
.ide-sidebar-body { padding: 8px; }
.repo-filter {
  width: 100%;
  display: grid;
  gap: 2px;
  padding: 9px 10px;
  border: 0;
  border-left: 2px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
}
.repo-filter small { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.repo-filter:hover, .repo-filter.is-active { background: var(--surface-2); color: var(--text-primary); border-left-color: var(--accent); }
.ide-main { min-width: 0; min-height: 0; background: var(--surface-2); overflow: auto; }
.module { min-height: 100%; display: grid; grid-template-rows: auto auto minmax(0, 1fr); background: var(--surface-1); }
.module-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px; padding: 0 12px; border-bottom: 1px solid var(--border-subtle); background: var(--surface-1); }
.module-header-shell { display: grid; gap: 3px; min-width: 0; }
.module-header-shell strong { font-size: 13px; }
.module-header-shell span { color: var(--text-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toolbar { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--border-subtle); background: var(--surface-1); }
.toolbar input {
  width: min(520px, 100%);
  height: 32px;
  border: 1px solid var(--border-default);
  background: var(--surface-2);
  color: var(--text-primary);
  padding: 0 10px;
  outline: none;
}
.toolbar input:focus { border-color: var(--accent); }
.muted { color: var(--text-muted); font-size: 12px; white-space: nowrap; }
.rows { min-height: 0; overflow: auto; }
.row { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; min-height: 54px; border-bottom: 1px solid var(--border-subtle); background: var(--surface-1); }
.row:hover { background: var(--surface-2); }
.row-main { display: grid; gap: 4px; min-width: 0; padding: 7px 16px; }
.title { color: var(--text-primary); font-weight: 560; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { display: flex; gap: 8px; min-width: 0; color: var(--text-muted); font-size: 12px; }
.meta span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-side { display: grid; gap: 4px; justify-items: end; padding: 7px 14px; color: var(--text-muted); font-size: 12px; white-space: nowrap; }
.ide-btn {
  min-height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 10px;
  border: 1px solid var(--border-default);
  background: var(--surface-2);
  color: var(--text-primary);
  cursor: pointer;
}
.ide-btn:hover { background: var(--surface-3); }
.ide-btn.full { width: 100%; margin-top: 14px; }
.ide-theme-toggle { width: 72px; height: 28px; padding: 0; border: 1px solid var(--border-default); background: var(--surface-2); color: var(--text-muted); cursor: pointer; }
.ide-theme-track { position: relative; display: grid; grid-template-columns: 1fr 1fr; align-items: center; height: 100%; }
.ide-theme-option { position: relative; z-index: 1; font-size: 11px; }
.ide-theme-thumb { position: absolute; top: 3px; left: 3px; width: 31px; height: 20px; background: var(--surface-3); border: 1px solid var(--border-default); transition: transform 150ms ease-out; }
.ide-shell[data-theme="light"] .ide-theme-thumb { transform: translateX(34px); }
.viewer-layout { display: grid; grid-template-columns: 300px minmax(0, 1fr); min-height: 0; }
.viewer-meta { padding: 14px; border-right: 1px solid var(--border-subtle); background: var(--surface-1); overflow: auto; }
.back-link { color: var(--text-muted); font-size: 12px; }
.viewer-title { margin-top: 16px; font-size: 18px; font-weight: 650; line-height: 1.2; }
dl { display: grid; gap: 5px; margin: 18px 0 0; }
dt { color: var(--text-muted); font-size: 11px; text-transform: uppercase; }
dd { margin: 0 0 10px; color: var(--text-secondary); overflow-wrap: anywhere; }
.preview-stage { min-width: 0; min-height: 0; background: #fff; }
iframe { width: 100%; height: 100%; border: 0; background: #fff; }
.empty, .not-found { padding: 24px; color: var(--text-muted); }
.not-found h1 { color: var(--text-primary); margin: 0 0 8px; }

@media (max-width: 780px) {
  body { overflow: auto; }
  .ide-shell { height: auto; min-height: 100vh; }
  .ide-body, .viewer-layout { grid-template-columns: 1fr; }
  .ide-sidebar { border-right: 0; border-bottom: 1px solid var(--border-subtle); max-height: 240px; }
  .row { grid-template-columns: 1fr; }
  .row-side { justify-items: start; padding: 0 16px 10px; }
  .preview-stage { height: 70vh; }
}
`;
