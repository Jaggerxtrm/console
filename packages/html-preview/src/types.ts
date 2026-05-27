export interface HtmlPreviewOptions {
  root: string;
  port: number;
  host: string;
  maxDepth: number;
  maxFiles: number;
}

export interface RepoEntry {
  id: string;
  name: string;
  path: string;
  relativePath: string;
}

export interface HtmlDocumentEntry {
  id: string;
  repoId: string;
  repoName: string;
  repoPath: string;
  path: string;
  title: string;
  size: number;
  modifiedAt: string;
}

export interface PreviewIndex {
  root: string;
  generatedAt: string;
  repos: RepoEntry[];
  documents: HtmlDocumentEntry[];
}
