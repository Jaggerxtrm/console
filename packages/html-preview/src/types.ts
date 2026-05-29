export interface HtmlPreviewOptions {
  root: string;
  roots: string[];
  port: number;
  host: string;
  maxDepth: number;
  maxFiles: number;
  excludeDirs?: string[];
  excludeSubtrees?: string[];
}

export interface RepoEntry {
  id: string;
  name: string;
  root: string;
  path: string;
  absolutePath: string;
  relativePath: string;
}

export type DocumentKind = "html" | "markdown" | "text";

export interface DocumentEntry {
  id: string;
  repoId: string;
  repoName: string;
  repoPath: string;
  absolutePath: string;
  path: string;
  folderPath: string;
  displayPath: string;
  kind: DocumentKind;
  title: string;
  size: number;
  modifiedAt: string;
  proximity: number;
}

export interface PreviewIndex {
  root: string;
  roots: string[];
  generatedAt: string;
  repos: RepoEntry[];
  documents: DocumentEntry[];
}
