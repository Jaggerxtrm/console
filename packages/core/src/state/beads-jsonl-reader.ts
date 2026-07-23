import { readFile } from "node:fs/promises";
import type { BeadDependency, BeadIssue } from "../types/beads.ts";
import { BeadsReader } from "./beads-reader.ts";

type BackupDependency = {
  issue_id: string;
  depends_on_id: string;
  type: string;
};

type BackupLabel = {
  issue_id: string;
  label: string;
};

/**
 * Reads the current Beads JSONL projection and preserves the historical
 * backup-directory fallback used by repositories created before issues.jsonl
 * moved to the .beads root.
 */
export async function readBeadsIssuesFromJsonl(beadsPath: string): Promise<BeadIssue[]> {
  const live = await readIssueFile(`${beadsPath}/issues.jsonl`, true);
  if (live.length > 0) return live;

  const issues = await readIssueFile(`${beadsPath}/backup/issues.jsonl`, false);
  if (issues.length === 0) return [];
  const [dependencies, labels] = await Promise.all([
    readJsonlFile<BackupDependency>(`${beadsPath}/backup/dependencies.jsonl`),
    readJsonlFile<BackupLabel>(`${beadsPath}/backup/labels.jsonl`),
  ]);
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  for (const issue of issues) {
    issue.dependencies = dependencies
      .filter((dependency) => dependency.issue_id === issue.id)
      .map((dependency): BeadDependency => ({
        id: dependency.depends_on_id,
        title: issueById.get(dependency.depends_on_id)?.title ?? dependency.depends_on_id,
        status: issueById.get(dependency.depends_on_id)?.status ?? "open",
        dependency_type: dependency.type as BeadDependency["dependency_type"],
      }));
    issue.labels = labels.filter((label) => label.issue_id === issue.id).map((label) => label.label);
  }
  return issues;
}

async function readIssueFile(path: string, filterTypedRows: boolean): Promise<BeadIssue[]> {
  try {
    const content = await readFile(path, "utf-8");
    return content.split("\n").flatMap((line) => {
      if (filterTypedRows) {
        const type = readRowType(line);
        if (type && type !== "issue") return [];
      }
      return BeadsReader.parseIssueLine(line);
    });
  } catch {
    return [];
  }
}

async function readJsonlFile<T>(path: string): Promise<T[]> {
  try {
    const content = await readFile(path, "utf-8");
    return content.split("\n").flatMap((line): T[] => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function readRowType(line: string): string | null {
  try {
    const value = JSON.parse(line) as { _type?: unknown };
    return typeof value._type === "string" ? value._type : null;
  } catch {
    return null;
  }
}
