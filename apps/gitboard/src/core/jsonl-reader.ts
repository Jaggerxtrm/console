/**
 * JSONL Reader - Read beads data from JSONL files (fallback for dolt)
 */

import { readFile } from "fs/promises";
import type { BeadIssue, BeadDependency } from "../types/beads.ts";

interface JsonlIssue {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  issue_type: string;
  owner: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  closed_at: string | null;
  close_reason: string | null;
}

interface JsonlDependency {
  issue_id: string;
  depends_on_id: string;
  type: string;
}

interface JsonlLabel {
  issue_id: string;
  label: string;
}

/**
 * Read issues from JSONL files. Prefer the live `.beads/issues.jsonl`; fall
 * back to the older `.beads/backup/issues.jsonl` layout used by early imports.
 */
export async function readIssuesFromJsonl(beadsPath: string): Promise<BeadIssue[]> {
  const live = await readLiveIssuesFromJsonl(beadsPath);
  if (live.length > 0) return live;
  return readBackupIssuesFromJsonl(beadsPath);
}

async function readLiveIssuesFromJsonl(beadsPath: string): Promise<BeadIssue[]> {
  try {
    const content = await readFile(`${beadsPath}/issues.jsonl`, "utf-8");
    return content.split("\n").flatMap(parseLiveIssueLine);
  } catch {
    return [];
  }
}

async function readBackupIssuesFromJsonl(beadsPath: string): Promise<BeadIssue[]> {
  try {
    const content = await readFile(`${beadsPath}/backup/issues.jsonl`, "utf-8");
    const lines = content.trim().split("\n");

    const issues: BeadIssue[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const data: JsonlIssue = JSON.parse(line);
        issues.push({
          id: data.id,
          title: data.title,
          description: data.description,
          status: data.status as BeadIssue["status"],
          priority: data.priority as BeadIssue["priority"],
          issue_type: data.issue_type as BeadIssue["issue_type"],
          owner: data.owner,
          created_at: data.created_at,
          created_by: data.created_by,
          updated_at: data.updated_at,
          closed_at: data.closed_at ?? undefined,
          close_reason: data.close_reason ?? undefined,
          project_id: "",
          dependencies: [],
          labels: [],
          related_ids: [],
        });
      } catch {
        // Skip malformed lines
      }
    }

    const deps = await readDependenciesFromJsonl(beadsPath);
    for (const issue of issues) {
      issue.dependencies = deps
        .filter(d => d.issue_id === issue.id)
        .map(d => ({
          id: d.depends_on_id,
          title: issues.find(i => i.id === d.depends_on_id)?.title || d.depends_on_id,
          status: issues.find(i => i.id === d.depends_on_id)?.status || "open",
          dependency_type: d.type as BeadDependency["dependency_type"],
        }));
    }

    const labels = await readLabelsFromJsonl(beadsPath);
    for (const issue of issues) {
      issue.labels = labels
        .filter(l => l.issue_id === issue.id)
        .map(l => l.label);
    }

    return issues;
  } catch {
    return [];
  }
}

function parseLiveIssueLine(line: string): BeadIssue[] {
  if (!line.trim()) return [];
  try {
    const data = JSON.parse(line) as Record<string, unknown>;
    if (data._type && data._type !== "issue") return [];
    if (typeof data.id !== "string" || typeof data.title !== "string") return [];
    const issueId = data.id;
    return [{
      id: issueId,
      title: data.title,
      description: data.description == null ? null : String(data.description),
      status: String(data.status ?? "open") as BeadIssue["status"],
      priority: Number(data.priority ?? 2) as BeadIssue["priority"],
      issue_type: String(data.issue_type ?? "task") as BeadIssue["issue_type"],
      owner: data.owner == null ? null : String(data.owner),
      assignee: data.assignee == null ? undefined : String(data.assignee),
      created_at: String(data.created_at ?? ""),
      created_by: data.created_by == null ? null : String(data.created_by),
      updated_at: String(data.updated_at ?? data.created_at ?? ""),
      closed_at: data.closed_at == null ? undefined : String(data.closed_at),
      close_reason: data.close_reason == null ? undefined : String(data.close_reason),
      project_id: "",
      dependencies: Array.isArray(data.dependencies) ? data.dependencies.flatMap((dependency) => parseLiveDependency(dependency, issueId)) : [],
      labels: Array.isArray(data.labels) ? data.labels.filter((label): label is string => typeof label === "string") : [],
      related_ids: Array.isArray(data.related_ids) ? data.related_ids.filter((id): id is string => typeof id === "string") : [],
      parent_id: data.parent_id == null ? undefined : String(data.parent_id),
    }];
  } catch {
    return [];
  }
}

function parseLiveDependency(value: unknown, issueId: string): BeadDependency[] {
  if (!value || typeof value !== "object") return [];
  const dependency = value as Record<string, unknown>;
  const id = dependency.depends_on_id ?? dependency.to_issue ?? dependency.id;
  if (typeof id !== "string" || id === issueId) return [];
  return [{
    id,
    title: typeof dependency.title === "string" ? dependency.title : "",
    status: String(dependency.status ?? "open") as BeadDependency["status"],
    dependency_type: String(dependency.type ?? dependency.dependency_type ?? "blocks") as BeadDependency["dependency_type"],
  }];
}

/**
 * Read dependencies from JSONL file
 */
async function readDependenciesFromJsonl(beadsPath: string): Promise<JsonlDependency[]> {
  try {
    const content = await readFile(`${beadsPath}/backup/dependencies.jsonl`, "utf-8");
    return content.trim().split("\n")
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as JsonlDependency);
  } catch {
    return [];
  }
}

/**
 * Read labels from JSONL file
 */
async function readLabelsFromJsonl(beadsPath: string): Promise<JsonlLabel[]> {
  try {
    const content = await readFile(`${beadsPath}/backup/labels.jsonl`, "utf-8");
    return content.trim().split("\n")
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as JsonlLabel);
  } catch {
    return [];
  }
}