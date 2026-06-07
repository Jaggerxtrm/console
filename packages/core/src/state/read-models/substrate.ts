// Pure SQL query services for the Substrate issue graph read model.
// Owns selection, dependency hydration, closed-issue ordering, and runtime-graph
// projection against the durable `substrate_issues` / `substrate_dependencies`
// / `substrate_issue_edges` tables. No HTTP, no caching, no app-specific types —
// the route layer adapts to Hono context and re-shapes DTOs.
//
// Opaque IDs are preserved verbatim (issue_id, parent_id, related_ids).

import type { Database } from "bun:sqlite";

export type SubstrateStatus = "open" | "in_progress" | "blocked" | "in_review" | "closed" | (string & {});

export interface SubstrateDependency {
  id: string;
  title: string;
  status: SubstrateStatus;
  issue_type?: string;
  dependency_type: string;
}

export interface SubstrateIssue {
  id: string;
  title: string;
  description: string | null;
  notes: string | null;
  status: SubstrateStatus;
  priority: number;
  issue_type: string;
  owner: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  closed_at?: string;
  close_reason?: string;
  project_id: string;
  dependencies: SubstrateDependency[];
  parent_id?: string;
  related_ids: string[];
  labels: string[];
}

export interface SubstrateRuntimeNode {
  id: string;
  title: string;
  state: string;
  priority: number;
  issue_type: string;
  labels: string[];
  parent_id: string | null;
  runtime_kind: string;
  formula_name: string | null;
  template_name: string | null;
  contract_kind: string | null;
  contract_xml: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface SubstrateRuntimeEdge {
  from: string;
  to: string;
  relation: string;
}

export interface SubstrateRuntimeGraph {
  nodes: SubstrateRuntimeNode[];
  edges: SubstrateRuntimeEdge[];
}

export interface SubstrateStats {
  total: number;
  open: number;
  in_progress: number;
  blocked: number;
  closed: number;
  by_priority: Record<string, number>;
  by_type: Record<string, number>;
}

export interface SubstrateIssueFilters {
  status?: readonly string[];
  priority?: readonly number[];
  search?: string;
  limit?: number;
}

const BASE_ISSUE_COLUMNS = "issue_id, title, body, state, priority, issue_type, owner, labels, related_ids, parent_id, deleted_at, closed_at, close_reason, notes, created_at, updated_at";

export function readSubstrateIssues(db: Database | null | undefined, projectId: string, filters: SubstrateIssueFilters = {}): SubstrateIssue[] {
  if (!db) return [];
  const issues = querySubstrateIssues(db, projectId);
  return applySubstrateIssueFilters(issues, filters);
}

export function readSubstrateClosedIssues(db: Database | null | undefined, projectId: string, limit: number): SubstrateIssue[] {
  if (!db) return [];
  const rows = db.query(`
    SELECT ${BASE_ISSUE_COLUMNS}
    FROM substrate_issues
    WHERE repo_slug = ?
      AND state = 'closed'
      AND (deleted_at IS NULL OR deleted_at = '')
    ORDER BY COALESCE(closed_at, updated_at, created_at) DESC, issue_id ASC
    LIMIT ?
  `).all(projectId, limit) as Array<Record<string, unknown>>;
  const issueIndex = new Map(rows.map((row) => [String(row.issue_id), row] as const));
  const dependencies = db.query("SELECT issue_id, dep_issue_id, relation FROM substrate_dependencies WHERE repo_slug = ?").all(projectId) as Array<{ issue_id: string; dep_issue_id: string; relation: string }>;
  const depsByIssue = buildDependencyIndex(dependencies, issueIndex);
  return rows.map((row) => mapIssueRow(row, projectId, depsByIssue.get(String(row.issue_id)) ?? []));
}

export function readSubstrateIssueDetail(db: Database | null | undefined, projectId: string, issueId: string): SubstrateIssue | null {
  if (!db) return null;
  const issue = querySubstrateIssues(db, projectId).find((row) => row.id === issueId);
  return issue ?? null;
}

export function readSubstrateIssueDependents(db: Database | null | undefined, projectId: string, issueId: string): SubstrateDependency[] {
  if (!db) return [];
  const rows = db.query("SELECT issue_id, relation FROM substrate_dependencies WHERE repo_slug = ? AND dep_issue_id = ? ORDER BY issue_id ASC").all(projectId, issueId) as Array<{ issue_id: string; relation: string }>;
  if (rows.length === 0) return [];
  const dependentIds = [...new Set(rows.map((row) => row.issue_id))];
  const dependentRows = db.query(
    `SELECT issue_id, title, state, issue_type
     FROM substrate_issues
     WHERE repo_slug = ? AND (deleted_at IS NULL OR deleted_at = '') AND issue_id IN (${dependentIds.map(() => "?").join(",")})`,
  ).all(projectId, ...dependentIds) as Array<{ issue_id: string; title: string | null; state: string | null; issue_type: string | null }>;
  const dependentById = new Map(dependentRows.map((row) => [row.issue_id, row] as const));

  return rows.map((row) => {
    const dependent = dependentById.get(row.issue_id);
    return {
      id: row.issue_id,
      title: dependent == null ? "" : String(dependent.title ?? ""),
      status: dependent == null ? "open" : String(dependent.state ?? "open"),
      issue_type: dependent == null ? undefined : String(dependent.issue_type ?? "task"),
      dependency_type: row.relation,
    };
  });
}

export function readSubstrateStats(db: Database | null | undefined, projectId: string): SubstrateStats {
  const issues = querySubstrateIssues(db, projectId);
  return issues.reduce<SubstrateStats>((acc, issue) => {
    acc.total += 1;
    if (issue.status === "open" || issue.status === "in_progress" || issue.status === "blocked" || issue.status === "closed") {
      acc[issue.status as keyof Pick<SubstrateStats, "open" | "in_progress" | "blocked" | "closed">] += 1;
    }
    return acc;
  }, { total: 0, open: 0, in_progress: 0, blocked: 0, closed: 0, by_priority: { p0: 0, p1: 0, p2: 0, p3: 0, p4: 0 }, by_type: { bug: 0, feature: 0, task: 0, epic: 0, chore: 0 } });
}

export function readSubstrateRuntimeGraph(db: Database | null | undefined, projectId: string): SubstrateRuntimeGraph {
  if (!db) return { nodes: [], edges: [] };
  const rows = db.query(`
    SELECT issue_id, title, state, priority, issue_type, labels, parent_id, runtime_kind,
           formula_name, template_name, contract_kind, contract_xml, metadata_json,
           created_at, updated_at
    FROM substrate_issues
    WHERE repo_slug = ? AND (deleted_at IS NULL OR deleted_at = '')
    ORDER BY issue_id ASC
  `).all(projectId) as Array<Record<string, unknown>>;
  const edges = db.query(`
    SELECT from_issue_id, to_issue_id, relation
    FROM substrate_issue_edges
    WHERE repo_slug = ?
    ORDER BY from_issue_id ASC, to_issue_id ASC, relation ASC
  `).all(projectId) as Array<{ from_issue_id: string; to_issue_id: string; relation: string }>;

  return {
    nodes: rows.map((row) => ({
      id: String(row.issue_id),
      title: String(row.title ?? ""),
      state: String(row.state ?? "open"),
      priority: Number(row.priority ?? 2),
      issue_type: String(row.issue_type ?? "task"),
      labels: parseJsonStringArray(row.labels),
      parent_id: row.parent_id == null ? null : String(row.parent_id),
      runtime_kind: String(row.runtime_kind ?? deriveRuntimeKindFromRow(row)),
      formula_name: row.formula_name == null ? null : String(row.formula_name),
      template_name: row.template_name == null ? null : String(row.template_name),
      contract_kind: row.contract_kind == null ? null : String(row.contract_kind),
      contract_xml: row.contract_xml == null ? null : String(row.contract_xml),
      metadata: parseJsonObject(row.metadata_json),
      created_at: row.created_at == null ? null : String(row.created_at),
      updated_at: row.updated_at == null ? null : String(row.updated_at),
    })),
    edges: edges.map((edge) => ({ from: edge.from_issue_id, to: edge.to_issue_id, relation: edge.relation })),
  };
}

function querySubstrateIssues(db: Database | null | undefined, projectId: string): SubstrateIssue[] {
  if (!db) return [];
  const rows = db.query(`SELECT ${BASE_ISSUE_COLUMNS} FROM substrate_issues WHERE repo_slug = ? AND (deleted_at IS NULL OR deleted_at = '') ORDER BY priority ASC, created_at DESC, issue_id ASC`).all(projectId) as Array<Record<string, unknown>>;
  const issueIndex = new Map(rows.map((row) => [String(row.issue_id), row] as const));
  const dependencies = db.query("SELECT issue_id, dep_issue_id, relation FROM substrate_dependencies WHERE repo_slug = ?").all(projectId) as Array<{ issue_id: string; dep_issue_id: string; relation: string }>;
  const depsByIssue = buildDependencyIndex(dependencies, issueIndex);
  return rows.map((row) => mapIssueRow(row, projectId, depsByIssue.get(String(row.issue_id)) ?? []));
}

function buildDependencyIndex(dependencies: ReadonlyArray<{ issue_id: string; dep_issue_id: string; relation: string }>, issueIndex: ReadonlyMap<string, Record<string, unknown>>): Map<string, SubstrateDependency[]> {
  const depsByIssue = new Map<string, SubstrateDependency[]>();
  for (const dep of dependencies) {
    const list = depsByIssue.get(dep.issue_id) ?? [];
    const target = issueIndex.get(dep.dep_issue_id);
    list.push({
      id: dep.dep_issue_id,
      title: target == null ? "" : String(target.title ?? ""),
      status: target == null ? "open" : String(target.state ?? "open"),
      issue_type: target == null ? undefined : String(target.issue_type ?? "task"),
      dependency_type: dep.relation,
    });
    depsByIssue.set(dep.issue_id, list);
  }
  return depsByIssue;
}

function mapIssueRow(row: Record<string, unknown>, projectId: string, dependencies: SubstrateDependency[]): SubstrateIssue {
  return {
    id: String(row.issue_id),
    title: String(row.title ?? ""),
    description: row.body == null ? null : String(row.body),
    notes: row.notes == null ? null : String(row.notes),
    status: String(row.state ?? "open"),
    priority: Number(row.priority ?? 2),
    issue_type: String(row.issue_type ?? "task"),
    owner: row.owner == null ? null : String(row.owner),
    created_at: String(row.created_at ?? new Date(0).toISOString()),
    created_by: null,
    updated_at: String(row.updated_at ?? new Date(0).toISOString()),
    closed_at: row.closed_at == null ? (row.deleted_at == null ? undefined : String(row.deleted_at)) : String(row.closed_at),
    close_reason: row.close_reason == null ? undefined : String(row.close_reason),
    project_id: projectId,
    dependencies,
    parent_id: row.parent_id == null ? undefined : String(row.parent_id),
    related_ids: parseJsonStringArray(row.related_ids),
    labels: parseJsonStringArray(row.labels),
  };
}

function applySubstrateIssueFilters(issues: SubstrateIssue[], filters: SubstrateIssueFilters): SubstrateIssue[] {
  let filtered = issues;
  if (filters.status?.length) {
    const wanted = new Set(filters.status);
    filtered = filtered.filter((issue) => wanted.has(issue.status));
  }
  if (filters.priority?.length) {
    const wanted = new Set(filters.priority);
    filtered = filtered.filter((issue) => wanted.has(issue.priority));
  }
  if (filters.search) {
    const search = filters.search.toLowerCase();
    filtered = filtered.filter((issue) =>
      issue.title.toLowerCase().includes(search) ||
      (issue.description?.toLowerCase().includes(search) ?? false) ||
      (issue.notes?.toLowerCase().includes(search) ?? false)
    );
  }
  return filters.limit == null ? filtered : filtered.slice(0, filters.limit);
}

function parseJsonStringArray(value: unknown): string[] {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function deriveRuntimeKindFromRow(row: Record<string, unknown>): string {
  const labels = parseJsonStringArray(row.labels);
  const issueType = String(row.issue_type ?? "task");
  if (issueType === "molecule" || labels.includes("kind:molecule")) return "chain_molecule";
  if (labels.includes("kind:step")) return "step";
  if (issueType === "epic") return "organizational_epic";
  return "root";
}
