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
 * Read issues from JSONL files in .beads/backup/
 */
export async function readIssuesFromJsonl(beadsPath: string): Promise<BeadIssue[]> {
  try {
    // Try backup/issues.jsonl first
    const issuesPath = `${beadsPath}/backup/issues.jsonl`;
    const content = await readFile(issuesPath, "utf-8");
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
          dependencies: [], // Will be populated separately
          labels: [], // Will be populated separately
          related_ids: [],
        });
      } catch {
        // Skip malformed lines
      }
    }

    // Load dependencies
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

    // Load labels
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