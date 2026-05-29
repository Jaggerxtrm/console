import type { DocumentEntry, PreviewIndex, RepoEntry } from "./types.ts";
import { encodePathSegments, escapeHtml } from "./security.ts";

const INITIAL_ROW_LIMIT = 160;

export function renderIndex(index: PreviewIndex): string {
  const explorer = renderExplorer(index);
  const rows = index.documents.slice(0, INITIAL_ROW_LIMIT).map(renderDocumentRow).join("");
  const documentData = serializeDocumentData(index.documents);

  return renderPage({
    title: "Doc Preview",
    body: `
      <div class="ide-shell" data-theme="dark">
        ${renderTopbar(index)}
        <div class="ide-body">
          <aside class="ide-sidebar">
            <div class="ide-sidebar-header">
              <div class="ide-sidebar-title">${octicon("repo")}Repositories</div>
              <div class="ide-sidebar-count">${index.repos.length}</div>
            </div>
            <div class="ide-sidebar-body">
              <button class="repo-filter filter-control is-active" data-repo="all" data-folder="all" type="button">All repositories</button>
              ${explorer}
            </div>
          </aside>
          <main class="ide-main">
            <section class="module">
              <header class="module-header">
                <div class="module-header-shell">
                  <strong>${octicon("fileCode")}Documents</strong>
                  <span>${escapeHtml(index.roots.join(" + "))}</span>
                </div>
                <form method="post" action="/api/refresh">
                  <button class="ide-btn" type="submit">Refresh</button>
                </form>
              </header>
              <div class="toolbar">
                <label class="search-field" for="search">
                  ${octicon("search")}
                <input id="search" type="search" placeholder="Filter by title, repo, format, or full path" autocomplete="off" />
                </label>
                <span class="muted" id="result-count">${index.documents.length} visible</span>
              </div>
              <div class="rows" id="rows">
                <div class="rows-spacer" id="rows-spacer">
                  <div class="rows-window" id="rows-window">${rows || renderEmptyState()}</div>
                </div>
                <div class="empty filtered-empty" id="filtered-empty" hidden>No matching documents.</div>
              </div>
            </section>
          </main>
        </div>
      </div>
      <script type="application/json" id="document-data">${documentData}</script>
      ${renderIndexScript()}
    `,
  });
}

export function renderViewer(
  index: PreviewIndex,
  document: DocumentEntry,
  rendered: { markdownHtml?: string; textContent?: string } = {},
): string {
  const rawPath = `/raw/${encodeURIComponent(document.repoId)}/${encodePathSegments(document.path)}`;
  const preview = renderPreviewContent(document, rawPath, rendered);
  return renderPage({
    title: `${document.title} - Doc Preview`,
    body: `
      <div class="ide-shell" data-theme="dark">
        ${renderTopbar(index)}
        <div class="viewer-layout">
          <aside class="viewer-meta">
            <a class="back-link" href="/">Back to index</a>
            <div class="viewer-title">${escapeHtml(document.title)}</div>
            <dl>
              <dt>Format</dt>
              <dd>${formatKind(document.kind)}</dd>
              <dt>Repository</dt>
              <dd>${escapeHtml(document.repoName)}</dd>
              <dt>Full path</dt>
              <dd>${escapeHtml(document.displayPath)}</dd>
              <dt>Modified</dt>
              <dd>${formatDate(document.modifiedAt)}</dd>
            </dl>
            <a class="ide-btn full" href="${rawPath}" target="_blank" rel="noreferrer">Open raw</a>
          </aside>
          ${preview}
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
        ${octicon("browser")}
        <span>Doc Preview</span>
      </div>
      <nav class="ide-topbar-tabs" aria-label="Preview sections">
        <span class="ide-tab is-active">${octicon("fileCode")} Documents</span>
      </nav>
      <div class="topbar-meta">Updated ${formatDate(index.generatedAt)}</div>
      <button class="ide-theme-toggle" type="button" aria-label="Toggle theme">
        <span class="ide-theme-track">
          <span class="ide-theme-option ide-theme-option-dark">${octicon("sun")}</span>
          <span class="ide-theme-option ide-theme-option-light">${octicon("moon")}</span>
          <span class="ide-theme-thumb"></span>
        </span>
      </button>
    </header>
  `;
}

function renderExplorer(index: PreviewIndex): string {
  const documentsByRepo = new Map<string, DocumentEntry[]>();
  for (const document of index.documents) {
    const documents = documentsByRepo.get(document.repoId) ?? [];
    documents.push(document);
    documentsByRepo.set(document.repoId, documents);
  }

  return index.repos.map((repo) => {
    const documents = documentsByRepo.get(repo.id) ?? [];
    if (documents.length === 0) {
      return "";
    }

    return `<div class="repo-group" data-repo="${escapeHtml(repo.id)}">
      <button class="repo-filter filter-control" data-repo="${escapeHtml(repo.id)}" data-folder="all" type="button">
        <span class="repo-filter-main">${octicon("repo")}<span>${escapeHtml(repo.name)}</span></span>
        <small>${escapeHtml(repo.relativePath)} · ${documents.length}</small>
      </button>
      <div class="folder-list" data-folder-list="${escapeHtml(repo.id)}"></div>
    </div>`;
  }).join("");
}

function renderFolderTree(repo: RepoEntry, tree: DocumentTree): string {
  const rootButton = tree.rootDocumentCount > 0
    ? renderFolderButton(repo, { path: ".", name: "./", documentCount: tree.rootDocumentCount, totalCount: tree.rootDocumentCount, children: new Map() }, 0)
    : "";
  return `${rootButton}${[...tree.children.values()].map((node) => renderFolderNode(repo, node, 0)).join("")}`;
}

function renderFolderNode(repo: RepoEntry, node: DocumentFolderNode, depth: number): string {
  const children = [...node.children.values()].map((child) => renderFolderNode(repo, child, depth + 1)).join("");
  return `<div class="folder-node" data-repo="${escapeHtml(repo.id)}" data-folder-node="${escapeHtml(node.path)}">
    ${renderFolderButton(repo, node, depth)}
    ${children ? `<div class="folder-children">${children}</div>` : ""}
  </div>`;
}

function renderFolderButton(repo: RepoEntry, node: DocumentFolderNode, depth: number): string {
  const hasChildren = node.children.size > 0 ? "true" : "false";
  return `<button class="folder-filter filter-control" style="--folder-depth: ${depth}" data-repo="${escapeHtml(repo.id)}" data-folder="${escapeHtml(node.path)}" data-has-children="${hasChildren}" type="button">
    <span class="folder-filter-label">${octicon("fileDirectory")}<span>${escapeHtml(node.name)}</span></span>
    <small>${node.totalCount}</small>
  </button>`;
}

function renderDocumentRow(document: DocumentEntry): string {
  const viewHref = `/view?repo=${encodeURIComponent(document.repoId)}&path=${encodeURIComponent(document.path)}`;
  return `<a class="row html-row document-row" href="${viewHref}" data-repo="${escapeHtml(document.repoId)}" data-folder="${escapeHtml(document.folderPath)}" data-search="${escapeHtml(`${document.title} ${document.repoName} ${document.kind} ${document.path} ${document.displayPath}`.toLowerCase())}">
    <span class="row-main">
      <span class="title">${octicon("fileCode")}${escapeHtml(document.title)}</span>
      <span class="meta">
        <span>${escapeHtml(document.repoName)}</span>
        <span>${formatKind(document.kind)}</span>
        <span>${escapeHtml(document.path)}</span>
        <span>${escapeHtml(document.displayPath)}</span>
      </span>
    </span>
    <span class="row-side">
      <span>${formatBytes(document.size)}</span>
      <span>${formatDate(document.modifiedAt)}</span>
    </span>
  </a>`;
}

function renderEmptyState(): string {
  return `<div class="empty">No documents found under these roots.</div>`;
}

interface DocumentFolderNode {
  path: string;
  name: string;
  documentCount: number;
  totalCount: number;
  children: Map<string, DocumentFolderNode>;
}

interface DocumentTree {
  rootDocumentCount: number;
  children: Map<string, DocumentFolderNode>;
}

interface DocumentFolderStat {
  path: string;
  count: number;
  proximity: number;
}

function getDocumentTree(documents: DocumentEntry[]): DocumentTree {
  const tree: DocumentTree = {
    rootDocumentCount: documents.filter((document) => document.folderPath === ".").length,
    children: new Map(),
  };

  for (const folder of getDocumentFolderStats(documents)) {
    if (folder.path === ".") {
      continue;
    }

    let children = tree.children;
    const parts = folder.path.split("/");
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      const path = parts.slice(0, index + 1).join("/");
      let node = children.get(name);
      if (!node) {
        node = {
          path,
          name,
          documentCount: 0,
          totalCount: 0,
          children: new Map(),
        };
        children.set(name, node);
      }
      if (index === parts.length - 1) {
        node.documentCount += folder.count;
      }
      node.totalCount += folder.count;
      children = node.children;
    }
  }

  sortFolderNodes(tree.children);
  return tree;
}

function getDocumentFolderStats(documents: DocumentEntry[]): DocumentFolderStat[] {
  const folders = new Map<string, DocumentFolderStat>();
  for (const document of documents) {
    const current = folders.get(document.folderPath);
    if (current) {
      current.count += 1;
      current.proximity = Math.min(current.proximity, document.proximity);
    } else {
      folders.set(document.folderPath, {
        path: document.folderPath,
        count: 1,
        proximity: document.proximity,
      });
    }
  }

  return [...folders.values()].sort((a, b) => (
    a.proximity - b.proximity || a.path.localeCompare(b.path)
  ));
}

function sortFolderNodes(nodes: Map<string, DocumentFolderNode>): void {
  const sorted = [...nodes.entries()].sort(([, a], [, b]) => a.name.localeCompare(b.name));
  nodes.clear();
  for (const [key, node] of sorted) {
    sortFolderNodes(node.children);
    nodes.set(key, node);
  }
}

function renderPreviewContent(
  document: DocumentEntry,
  rawPath: string,
  rendered: { markdownHtml?: string; textContent?: string },
): string {
  if (document.kind === "html") {
    return `<main class="preview-stage html-stage">
      <iframe src="${rawPath}" sandbox="allow-forms allow-modals allow-popups allow-scripts allow-same-origin"></iframe>
    </main>`;
  }

  if (document.kind === "markdown") {
    return `<main class="preview-stage document-stage">
      <article class="markdown-body">${rendered.markdownHtml ?? ""}</article>
    </main>`;
  }

  return `<main class="preview-stage document-stage">
    <pre class="text-document">${escapeHtml(rendered.textContent ?? "")}</pre>
  </main>`;
}

function formatKind(kind: DocumentEntry["kind"]): string {
  if (kind === "html") return "HTML";
  if (kind === "markdown") return "Markdown";
  return "Text";
}

function octicon(name: "browser" | "fileCode" | "fileDirectory" | "moon" | "repo" | "search" | "sun"): string {
  const paths = {
    browser: "M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25ZM14.5 6h-13v7.25c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25Zm-6-3.5v2h6V2.75a.25.25 0 0 0-.25-.25ZM5 2.5v2h2v-2Zm-3.25 0a.25.25 0 0 0-.25.25V4.5h2v-2Z",
    fileCode: "M4 1.75C4 .784 4.784 0 5.75 0h5.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v8.586A1.75 1.75 0 0 1 14.25 15h-9a.75.75 0 0 1 0-1.5h9a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 10 4.25V1.5H5.75a.25.25 0 0 0-.25.25v2.5a.75.75 0 0 1-1.5 0Zm1.72 4.97a.75.75 0 0 1 1.06 0l2 2a.75.75 0 0 1 0 1.06l-2 2a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l1.47-1.47-1.47-1.47a.75.75 0 0 1 0-1.06ZM3.28 7.78 1.81 9.25l1.47 1.47a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-2-2a.75.75 0 0 1 0-1.06l2-2a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Zm8.22-6.218V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z",
    fileDirectory: "M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2A1.75 1.75 0 0 0 5 1Zm0 1.5H5c.079 0 .153.037.2.1l.9 1.2A1.75 1.75 0 0 0 7.5 4.5h6.75a.25.25 0 0 1 .25.25v.75h-13V2.75a.25.25 0 0 1 .25-.25Zm-.25 4.5h13v6.25a.25.25 0 0 1-.25.25H1.75a.25.25 0 0 1-.25-.25Z",
    moon: "M9.598 1.591a.749.749 0 0 1 .785-.175 7.001 7.001 0 1 1-8.967 8.967.75.75 0 0 1 .961-.96 5.5 5.5 0 0 0 7.046-7.046.75.75 0 0 1 .175-.786Zm1.616 1.945a7 7 0 0 1-7.678 7.678 5.499 5.499 0 1 0 7.678-7.678Z",
    repo: "M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z",
    search: "M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z",
    sun: "M8 12a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm0-1.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm5.657-8.157a.75.75 0 0 1 0 1.061l-1.061 1.06a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l1.06-1.06a.75.75 0 0 1 1.06 0Zm-9.193 9.193a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 1 1-1.061-1.06l1.06-1.061a.75.75 0 0 1 1.061 0ZM8 0a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0ZM3 8a.75.75 0 0 1-.75.75H.75a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 3 8Zm13 0a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 16 8Zm-8 5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13Zm3.536-1.464a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 0 1-1.06 1.061l-1.061-1.06a.75.75 0 0 1 0-1.061ZM2.343 2.343a.75.75 0 0 1 1.061 0l1.06 1.061a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-1.06-1.06a.75.75 0 0 1 0-1.06Z",
  };

  return `<svg class="octicon" aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path d="${paths[name]}"></path></svg>`;
}

interface SerializedDocument {
  r: string;
  n: string;
  f: string;
  t: string;
  k: DocumentEntry["kind"];
  p: string;
  d: string;
  z: number;
  m: string;
}

function serializeDocumentData(documents: DocumentEntry[]): string {
  const serialized: SerializedDocument[] = documents.map((document) => ({
    r: document.repoId,
    n: document.repoName,
    f: document.folderPath,
    t: document.title,
    k: document.kind,
    p: document.path,
    d: document.displayPath,
    z: document.size,
    m: document.modifiedAt,
  }));
  return JSON.stringify(serialized).replace(/</g, "\u003c");
}

function renderIndexScript(): string {
  const fileIcon = JSON.stringify(octicon("fileCode"));
  return `<script>
${themeScript}
const rowData = JSON.parse(document.querySelector("#document-data")?.textContent || "[]").map((item) => ({
  repo: item.r,
  repoName: item.n,
  folder: item.f,
  title: item.t,
  kind: item.k,
  path: item.p,
  displayPath: item.d,
  size: item.z,
  modifiedAt: item.m,
  search: (item.t + " " + item.n + " " + item.k + " " + item.p + " " + item.d).toLowerCase(),
}));
const fileIcon = ${fileIcon};
const search = document.querySelector("#search");
const rowsViewport = document.querySelector("#rows");
const rowsSpacer = document.querySelector("#rows-spacer");
const rowsWindow = document.querySelector("#rows-window");
const count = document.querySelector("#result-count");
const sidebar = document.querySelector(".ide-sidebar-body");
const empty = document.querySelector("#filtered-empty");
const rowsByRepo = new Map();
for (const row of rowData) {
  const group = rowsByRepo.get(row.repo) || [];
  group.push(row);
  rowsByRepo.set(row.repo, group);
}
const repoGroupsById = new Map(Array.from(document.querySelectorAll(".repo-group")).map((group) => [group.dataset.repo || "", group]));
const expandedRepos = new Set();
const expandedFolders = new Set();
const ROW_HEIGHT = 52;
const ROW_BUFFER = 12;
const MAX_RENDERED_ROWS = 160;
let activeRepo = "all";
let activeFolder = "all";
let filterFrame = 0;
let renderFrame = 0;
let visibleRows = rowData;

function escapeMarkup(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === "'") return "&#39;";
    return "&quot;";
  });
}


function escapeAttr(value) {
  return escapeMarkup(value);
}

function formatKind(kind) {
  if (kind === "html") return "HTML";
  if (kind === "markdown") return "Markdown";
  return "Text";
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function renderRow(row) {
  const viewHref = "/view?repo=" + encodeURIComponent(row.repo) + "&path=" + encodeURIComponent(row.path);
  return '<a class="row html-row document-row" href="' + escapeAttr(viewHref) + '" data-repo="' + escapeAttr(row.repo) + '" data-folder="' + escapeAttr(row.folder) + '">' +
    '<span class="row-main">' +
      '<span class="title">' + fileIcon + escapeMarkup(row.title) + '</span>' +
      '<span class="meta">' +
        '<span>' + escapeMarkup(row.repoName) + '</span>' +
        '<span>' + escapeMarkup(formatKind(row.kind)) + '</span>' +
        '<span>' + escapeMarkup(row.path) + '</span>' +
        '<span>' + escapeMarkup(row.displayPath) + '</span>' +
      '</span>' +
    '</span>' +
    '<span class="row-side">' +
      '<span>' + escapeMarkup(formatBytes(row.size)) + '</span>' +
      '<span>' + escapeMarkup(formatDate(row.modifiedAt)) + '</span>' +
    '</span>' +
  '</a>';
}

function syncExplorerState() {
  for (const [repo, group] of repoGroupsById) {
    group.classList.toggle("is-expanded", expandedRepos.has(repo));
  }
  for (const node of document.querySelectorAll(".folder-node")) {
    const key = (node.dataset.repo || "") + "::" + (node.dataset.folderNode || "");
    node.classList.toggle("is-expanded", expandedFolders.has(key));
  }
  for (const item of document.querySelectorAll(".filter-control")) {
    item.classList.toggle("is-active", (item.dataset.repo || "all") === activeRepo && (item.dataset.folder || "all") === activeFolder);
  }
}

function folderStatsForRepo(repo) {
  const folders = new Map();
  for (const row of rowsByRepo.get(repo) || []) {
    const current = folders.get(row.folder);
    if (current) {
      current.count += 1;
    } else {
      folders.set(row.folder, { path: row.folder, count: 1 });
    }
  }
  return Array.from(folders.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function buildFolderTree(repo) {
  const tree = { rootDocumentCount: 0, children: new Map() };
  for (const folder of folderStatsForRepo(repo)) {
    if (folder.path === ".") {
      tree.rootDocumentCount += folder.count;
      continue;
    }
    let children = tree.children;
    const parts = folder.path.split("/");
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      const path = parts.slice(0, index + 1).join("/");
      let node = children.get(name);
      if (!node) {
        node = { path, name, documentCount: 0, totalCount: 0, children: new Map() };
        children.set(name, node);
      }
      if (index === parts.length - 1) {
        node.documentCount += folder.count;
      }
      node.totalCount += folder.count;
      children = node.children;
    }
  }
  sortFolderNodes(tree.children);
  return tree;
}

function sortFolderNodes(nodes) {
  const sorted = Array.from(nodes.entries()).sort((a, b) => a[1].name.localeCompare(b[1].name));
  nodes.clear();
  for (const [key, node] of sorted) {
    sortFolderNodes(node.children);
    nodes.set(key, node);
  }
}

function renderFolderButton(repo, node, depth) {
  const hasChildren = node.children.size > 0 ? "true" : "false";
  return '<button class="folder-filter filter-control" style="--folder-depth: ' + depth + '" data-repo="' + escapeAttr(repo) + '" data-folder="' + escapeAttr(node.path) + '" data-has-children="' + hasChildren + '" type="button">' +
    '<span class="folder-filter-label"><svg class="octicon" aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2A1.75 1.75 0 0 0 5 1Zm0 1.5H5c.079 0 .153.037.2.1l.9 1.2A1.75 1.75 0 0 0 7.5 4.5h6.75a.25.25 0 0 1 .25.25v.75h-13V2.75a.25.25 0 0 1 .25-.25Zm-.25 4.5h13v6.25a.25.25 0 0 1-.25.25H1.75a.25.25 0 0 1-.25-.25Z"></path></svg><span>' + escapeMarkup(node.name) + '</span></span>' +
    '<small>' + node.totalCount + '</small>' +
  '</button>';
}

function renderFolderNode(repo, node, depth) {
  const children = Array.from(node.children.values()).map((child) => renderFolderNode(repo, child, depth + 1)).join("");
  return '<div class="folder-node" data-repo="' + escapeAttr(repo) + '" data-folder-node="' + escapeAttr(node.path) + '">' +
    renderFolderButton(repo, node, depth) +
    (children ? '<div class="folder-children">' + children + '</div>' : '') +
  '</div>';
}

function renderFolderTree(repo) {
  const tree = buildFolderTree(repo);
  const root = tree.rootDocumentCount > 0
    ? renderFolderButton(repo, { path: ".", name: "./", documentCount: tree.rootDocumentCount, totalCount: tree.rootDocumentCount, children: new Map() }, 0)
    : "";
  return root + Array.from(tree.children.values()).map((node) => renderFolderNode(repo, node, 0)).join("");
}

function ensureFolderList(repo) {
  const group = repoGroupsById.get(repo);
  const list = group?.querySelector(".folder-list");
  if (!list || list.dataset.rendered === "true") {
    return;
  }
  list.innerHTML = renderFolderTree(repo);
  list.dataset.rendered = "true";
}

function renderRows(resetScroll) {
  if (!rowsViewport || !rowsSpacer || !rowsWindow) {
    return;
  }
  rowsViewport.classList.add("is-windowed");
  if (resetScroll) {
    rowsViewport.scrollTop = 0;
  }
  const viewportHeight = rowsViewport.clientHeight || 600;
  const start = Math.max(0, Math.floor(rowsViewport.scrollTop / ROW_HEIGHT) - ROW_BUFFER);
  const renderCount = Math.min(Math.ceil(viewportHeight / ROW_HEIGHT) + ROW_BUFFER * 2, MAX_RENDERED_ROWS);
  const end = Math.min(visibleRows.length, start + renderCount);
  rowsSpacer.style.height = Math.max(visibleRows.length * ROW_HEIGHT, viewportHeight) + "px";
  rowsWindow.style.transform = "translateY(" + (start * ROW_HEIGHT) + "px)";
  rowsWindow.innerHTML = visibleRows.slice(start, end).map(renderRow).join("");
  if (empty) empty.hidden = visibleRows.length !== 0 || rowData.length === 0;
}

function applyFilters() {
  const term = (search?.value || "").trim().toLowerCase();
  const candidates = activeRepo === "all" ? rowData : rowsByRepo.get(activeRepo) || [];
  visibleRows = candidates.filter((row) => {
    const folderMatches = activeFolder === "all" || row.folder === activeFolder || row.folder.startsWith(activeFolder + "/");
    const textMatches = !term || row.search.includes(term);
    return folderMatches && textMatches;
  });
  if (count) count.textContent = visibleRows.length + " visible";
  renderRows(true);
}

function scheduleFilters() {
  if (filterFrame) {
    cancelAnimationFrame(filterFrame);
  }
  filterFrame = requestAnimationFrame(() => {
    filterFrame = 0;
    applyFilters();
  });
}

function scheduleRenderRows() {
  if (renderFrame) {
    return;
  }
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    renderRows(false);
  });
}

sidebar?.addEventListener("click", (event) => {
  const filter = event.target instanceof Element ? event.target.closest(".filter-control") : null;
  if (!filter) {
    return;
  }
  const nextRepo = filter.dataset.repo || "all";
  const nextFolder = filter.dataset.folder || "all";
  if (nextRepo === "all") {
    expandedRepos.clear();
    expandedFolders.clear();
  } else if (nextFolder === "all") {
    if (expandedRepos.has(nextRepo) && activeRepo === nextRepo && activeFolder === "all") {
      expandedRepos.delete(nextRepo);
    } else {
      ensureFolderList(nextRepo);
      expandedRepos.add(nextRepo);
    }
  } else if (filter.dataset.hasChildren === "true") {
    const key = nextRepo + "::" + nextFolder;
    if (expandedFolders.has(key)) {
      expandedFolders.delete(key);
    } else {
      expandedFolders.add(key);
    }
    expandedRepos.add(nextRepo);
  } else {
    expandedRepos.add(nextRepo);
  }
  activeRepo = nextRepo;
  activeFolder = nextFolder;
  syncExplorerState();
  scheduleFilters();
});

search?.addEventListener("input", scheduleFilters);
rowsViewport?.addEventListener("scroll", scheduleRenderRows, { passive: true });
window.addEventListener("resize", scheduleRenderRows, { passive: true });
if (new URLSearchParams(window.location.search).has("refreshing")) {
  const status = document.createElement("span");
  status.className = "muted refresh-note";
  status.textContent = "Refreshing in background…";
  document.querySelector(".toolbar")?.append(status);
}
applyFilters();
</script>`;
}

function renderThemeScript(): string {
  return `<script>${themeScript}</script>`;
}

const themeScript = `
const shell = document.querySelector(".ide-shell");
const themeStorage = {
  get() {
    try { return localStorage.getItem("xtrm-html-preview-theme"); } catch { return null; }
  },
  set(value) {
    try { localStorage.setItem("xtrm-html-preview-theme", value); } catch {}
  }
};
const savedTheme = themeStorage.get() || "dark";
shell?.setAttribute("data-theme", savedTheme);
document.querySelector(".ide-theme-toggle")?.addEventListener("click", () => {
  const next = shell?.getAttribute("data-theme") === "light" ? "dark" : "light";
  shell?.setAttribute("data-theme", next);
  themeStorage.set(next);
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
:root {
  --bg: #101010;
  --surface-backdrop: #101010;
  --surface-primary: #101010;
  --surface-secondary: #1a1a1a;
  --surface-tertiary: #222222;
  --surface-1: #101010;
  --surface-2: #1a1a1a;
  --surface-3: #222222;
  --surface-hover: rgba(255, 255, 255, 0.06);
  --border-subtle: rgba(255, 255, 255, 0.1);
  --border-default: #303030;
  --border-strong: #3a3a3a;
  --text-primary: #f2f2f2;
  --text-secondary: #c7c7c7;
  --text-muted: #8f8f8f;
  --text-disabled: #626262;
  --accent: #b8b8b8;
  --accent-green: #7fbf8f;
  --row-hover: rgba(255, 255, 255, 0.025);
  --font-ui: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
  --header-font-size: 12.5px;
  --sidebar-width: clamp(220px, 22vw, 320px);
  --topbar-height: 40px;
}

*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body { font-family: var(--font-ui); font-size: 13px; background: var(--bg); color: var(--text-primary); overflow: hidden; }
a { color: inherit; text-decoration: none; }
button, input { font: inherit; }
[hidden] { display: none !important; }
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
  --surface-backdrop: #ffffff;
  --surface-primary: #ffffff;
  --surface-secondary: #f6f8fa;
  --surface-tertiary: #eef1f4;
  --surface-1: #ffffff;
  --surface-2: #f6f8fa;
  --surface-3: #eef1f4;
  --surface-hover: rgba(15, 23, 42, 0.045);
  --border-subtle: rgba(31, 35, 40, 0.12);
  --border-default: #e5e7eb;
  --border-strong: #c7c7c7;
  --text-primary: #0f172a;
  --text-secondary: #334155;
  --text-muted: #64748b;
  --text-disabled: #8f8f8f;
  --accent: #24292f;
  --row-hover: rgba(15, 23, 42, 0.035);
}

.ide-topbar {
  display: flex;
  align-items: stretch;
  min-width: 0;
  height: var(--topbar-height);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--surface-primary);
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 156px;
  padding: 0 14px;
  border-right: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  font-size: 12.5px;
  font-weight: 600;
}
.brand .octicon { color: var(--text-muted); }
.ide-topbar-tabs { display: flex; align-items: stretch; flex: 1; min-width: 0; padding: 0 12px; }
.ide-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-bottom: 2px solid var(--accent);
  color: var(--text-primary);
  font-size: 12.5px;
  font-weight: 500;
  padding: 0 14px;
  white-space: nowrap;
}
.topbar-meta { display: inline-flex; align-items: center; padding: 0 14px; color: var(--text-muted); font-size: 12px; white-space: nowrap; }
.ide-body { display: grid; grid-template-columns: var(--sidebar-width) minmax(0, 1fr); min-height: 0; }
.ide-sidebar { min-height: 0; border-right: 1px solid var(--border-subtle); background: var(--surface-primary); overflow: auto; }
.ide-sidebar-header { height: 32px; display: flex; align-items: center; justify-content: space-between; padding: 0 10px; border-bottom: 1px solid var(--border-subtle); }
.ide-sidebar-title { display: inline-flex; align-items: center; gap: 8px; color: var(--text-muted); font-size: var(--header-font-size); font-weight: 600; letter-spacing: 0.12em; }
.ide-sidebar-count { background: var(--surface-secondary); color: var(--text-muted); font-size: 10px; font-variant-numeric: tabular-nums; padding: 1px 5px; }
.ide-sidebar-body { padding: 6px 0; }
.repo-filter {
  width: 100%;
  display: grid;
  gap: 1px;
  padding: 7px 12px 7px 14px;
  border: 0;
  border-left: 1px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
}
.repo-filter-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
.repo-filter-main span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.repo-filter .octicon { color: var(--text-muted); flex: 0 0 auto; }
.repo-filter small { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.repo-filter:hover, .repo-filter.is-active { background: var(--row-hover); color: var(--text-primary); border-left-color: var(--accent); }
.repo-group { border-bottom: 1px solid var(--border-subtle); }
.folder-list { display: none; padding: 0 0 5px 34px; }
.repo-group.is-expanded .folder-list { display: block; }
.folder-children { display: none; }
.folder-node.is-expanded > .folder-children { display: block; }
.folder-filter {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  padding: 3px 10px 3px calc(var(--folder-depth, 0) * 13px);
  border: 0;
  border-left: 1px solid transparent;
  background: transparent;
  color: var(--text-muted);
  text-align: left;
  cursor: pointer;
  font-size: 12px;
}
.folder-filter-label { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.folder-filter-label .octicon { color: var(--text-disabled); flex: 0 0 auto; }
.folder-filter-label span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.folder-filter small { color: var(--text-disabled); font-variant-numeric: tabular-nums; }
.folder-filter:hover,
.folder-filter.is-active { color: var(--text-primary); }
.ide-main { min-width: 0; min-height: 0; background: var(--surface-1); overflow: auto; }
.module { min-height: 100%; display: grid; grid-template-rows: auto auto minmax(0, 1fr); background: var(--surface-1); }
.module-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px; padding: 0 12px; border-bottom: 1px solid var(--border-subtle); background: var(--surface-1); }
.module-header-shell { display: grid; gap: 3px; min-width: 0; }
.module-header-shell strong { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 650; }
.module-header-shell span { color: var(--text-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toolbar { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--border-subtle); background: var(--surface-1); }
.search-field {
  width: min(520px, 100%);
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  border: 1px solid var(--border-default);
  background: var(--surface-2);
  color: var(--text-primary);
  padding: 0 10px;
}
.search-field .octicon { color: var(--text-muted); }
.toolbar input {
  min-width: 0;
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  outline: none;
}
.search-field:focus-within { border-color: var(--border-strong); }
.muted { color: var(--text-muted); font-size: 12px; white-space: nowrap; }
.rows { min-height: 0; overflow: auto; position: relative; }
.rows.is-windowed .rows-spacer { position: relative; min-height: 100%; }
.rows.is-windowed .rows-window { position: absolute; top: 0; left: 0; right: 0; }
.row { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; min-height: 52px; border-bottom: 1px solid var(--border-subtle); background: var(--surface-1); }
.row:hover { background: var(--row-hover); }
.row-main { display: grid; gap: 4px; min-width: 0; padding: 7px 16px; }
.title { display: flex; align-items: center; gap: 8px; color: var(--text-primary); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.title .octicon { color: var(--text-muted); flex: 0 0 auto; }
.meta { display: flex; gap: 8px; min-width: 0; color: var(--text-muted); font-size: 12px; }
.meta span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta span:last-child { flex: 1 1 auto; }
.row-side { display: grid; gap: 4px; justify-items: end; padding: 7px 14px; color: var(--text-muted); font-size: 12px; white-space: nowrap; }
.ide-btn {
  min-height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 10px;
  border: 1px solid var(--border-default);
  background: var(--surface-1);
  color: var(--text-primary);
  cursor: pointer;
}
.ide-btn:hover { background: var(--surface-hover); }
.ide-btn.full { width: 100%; margin-top: 14px; }
.ide-theme-toggle { display: inline-flex; align-items: center; justify-content: center; min-width: 70px; height: 100%; padding: 0 14px; border: 0; border-left: 1px solid var(--border-subtle); background: transparent; color: var(--text-muted); cursor: pointer; }
.ide-theme-track { position: relative; display: inline-grid; grid-template-columns: 20px 20px; align-items: center; width: 44px; height: 24px; padding: 1px; border: 1px solid var(--border-strong); border-radius: 999px; background: var(--surface-tertiary); }
.ide-theme-option { display: inline-flex; align-items: center; justify-content: center; position: relative; z-index: 1; color: var(--text-disabled); }
.ide-theme-option .octicon { width: 12px; height: 12px; }
.ide-theme-thumb { position: absolute; top: 1px; left: 1px; width: 20px; height: 20px; border-radius: 999px; background: var(--text-primary); box-shadow: 0 0 0 1px var(--border-subtle); transition: transform 150ms ease-out; }
.ide-shell[data-theme="light"] .ide-theme-thumb { transform: translateX(20px); }
.octicon { display: inline-block; overflow: visible; fill: currentColor; vertical-align: text-bottom; }
.viewer-layout { display: grid; grid-template-columns: 300px minmax(0, 1fr); min-height: 0; }
.viewer-meta { padding: 14px; border-right: 1px solid var(--border-subtle); background: var(--surface-1); overflow: auto; }
.back-link { color: var(--text-muted); font-size: 12px; }
.viewer-title { margin-top: 16px; font-size: 18px; font-weight: 650; line-height: 1.2; }
dl { display: grid; gap: 5px; margin: 18px 0 0; }
dt { color: var(--text-muted); font-size: 11px; text-transform: uppercase; }
dd { margin: 0 0 10px; color: var(--text-secondary); overflow-wrap: anywhere; }
.preview-stage { min-width: 0; min-height: 0; background: #fff; }
.document-stage { overflow: auto; background: var(--surface-1); }
iframe { width: 100%; height: 100%; border: 0; background: #fff; }
.markdown-body {
  max-width: 920px;
  margin: 0 auto;
  padding: 36px 40px 72px;
  color: var(--text-primary);
  font-size: 15px;
  line-height: 1.65;
}
.markdown-body h1,
.markdown-body h2,
.markdown-body h3 {
  margin: 1.4em 0 0.5em;
  line-height: 1.2;
}
.markdown-body h1:first-child,
.markdown-body h2:first-child,
.markdown-body h3:first-child { margin-top: 0; }
.markdown-body p,
.markdown-body ul,
.markdown-body ol,
.markdown-body pre,
.markdown-body blockquote { margin: 0 0 1em; }
.markdown-body a { color: var(--text-primary); text-decoration: underline; text-decoration-color: var(--border-strong); }
.markdown-body code,
.markdown-body pre,
.text-document { font-family: var(--font-mono); }
.markdown-body code {
  padding: 1px 4px;
  border: 1px solid var(--border-subtle);
  background: var(--surface-2);
  font-size: 0.9em;
}
.markdown-body pre {
  overflow: auto;
  padding: 12px;
  border: 1px solid var(--border-subtle);
  background: var(--surface-2);
}
.markdown-body pre code { padding: 0; border: 0; background: transparent; }
.markdown-body blockquote {
  padding-left: 12px;
  border-left: 2px solid var(--border-strong);
  color: var(--text-secondary);
}
.text-document {
  margin: 0;
  padding: 24px;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}
.empty, .not-found { padding: 24px; color: var(--text-muted); }
.filtered-empty { border-bottom: 1px solid var(--border-subtle); }
.not-found h1 { color: var(--text-primary); margin: 0 0 8px; }

@media (max-width: 780px) {
  body { overflow: auto; }
  .ide-shell { height: auto; min-height: 100vh; }
  .brand { min-width: 156px; padding: 0 12px; }
  .ide-topbar-tabs { padding: 0; }
  .ide-tab { padding: 0 12px; }
  .topbar-meta { display: none; }
  .ide-body, .viewer-layout { grid-template-columns: 1fr; }
  .ide-sidebar { border-right: 0; border-bottom: 1px solid var(--border-subtle); max-height: 240px; }
  .row { grid-template-columns: 1fr; }
  .row-side { justify-items: start; padding: 0 16px 10px; }
  .preview-stage { height: 70vh; }
  .document-stage { height: auto; min-height: 70vh; }
  .markdown-body { padding: 24px 16px 48px; }
}
`;
