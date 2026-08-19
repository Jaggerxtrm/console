// Deterministic Mercury programme read model (schema v3).
// Faithful TypeScript port of mercuryintelligence/program `dashboard/build_snapshot.py`
// + `dashboard/enrich_snapshot.py` semantics (PR #118, merged at 159e3b5f):
//  - governed YAML/frontmatter parsing (nested tree + flattened `[]` paths);
//  - builder-level identity collision hubs + path-qualified duplicate records;
//  - strong/weak typed relations with source-field provenance;
//  - subject-aware nested-relation extraction (embedded records with their own
//    actor_id/id are never attributed to the outer record);
//  - WS-009 current STATE precedence over historical PLAN baseline;
//  - state/journal/publication continuity entities and wrapper-owned facts;
//  - provenance UNKNOWN boundaries (no inferred actor/principal/receipt);
//  - deterministic output (sorted references, stable ordering).

import type {
  IdentityCollision,
  JournalRecord,
  ProgrammeActivity,
  ProgrammeAgent,
  ProgrammeAssignment,
  ProgrammeBusiness,
  ProgrammeEdge,
  ProgrammeGoverned,
  ProgrammeGraph,
  ProgrammeNode,
  ProgrammeProvenance,
  ProgrammeRef,
  ProgrammeSnapshot,
  ProgrammeWorkstream,
  PublicationRecord,
  StateRecord,
} from "../../types/programme.ts";

// ── Providers ─────────────────────────────────────────────────────────────────
// Abstraction over where governed files come from. The live route uses the
// GitHub Contents adapter (server-side); tests inject fixture maps.

export type FileProvider = (path: string) => Promise<string | null>;
export type DirLister = (path: string) => Promise<string[]>;
/** Optional per-path fallback timestamp (e.g. HTTP Last-Modified). */
export type TimestampProvider = (path: string) => Promise<string | null>;

export interface ProgrammeSource {
  read: FileProvider;
  listDir: DirLister;
  /** Fetch N most recent commits for the activity view. */
  recentCommits: (n: number) => Promise<ProgrammeActivity[]>;
  timestamp?: TimestampProvider;
  repository: string;
  branch: string;
}

/** Build a hermetic ProgrammeSource from an in-memory map of path → content
 * (used by tests and offline/offline preview). Directories are implied by
 * the paths present in the map. */
export function createMapProgrammeSource(files: Map<string, string>, options: { repository?: string; branch?: string; activity?: ProgrammeActivity[] } = {}): ProgrammeSource {
  const read: FileProvider = async (path) => files.get(path) ?? null;
  const listDir: DirLister = async (path) => {
    const prefix = path ? `${path}/` : "";
    const childPaths = new Set<string>();
    for (const key of files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      childPaths.add(slash >= 0 ? rest.slice(0, slash) : rest);
    }
    return [...childPaths].map((name) => (path ? `${path}/${name}` : name)).sort();
  };
  return {
    read,
    listDir,
    recentCommits: async () => options.activity ?? [],
    repository: options.repository ?? "mercuryintelligence/program",
    branch: options.branch ?? "master",
  };
}

// ── Regex / constants (mirror the Python builder) ────────────────────────────

const ISSUE_RE = /\bISSUE-\d+\b/gi;
const ID_RE = /\b(?:WS|OPS|EXP|RESEARCH|PROP|ADR)-\d+\b/gi;
const STATUS_RE = /^(?:Status|State):\s*\*{0,2}([^\n*]+)/gim;
// JavaScript has no Python-style \A anchor. Use ^ so governed Markdown
// frontmatter is actually parsed rather than silently treated as body text.
const FM_RE = /^---\s*\n(.*?)\n---\s*\n/s;
const CANONICAL_RESEARCH_ID_RE = /^RESEARCH-\d+$/i;
const WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, "forty-two": 42, fifty: 50,
};

// ── YAML / frontmatter helpers ────────────────────────────────────────────────

import { parse as parseYamlLib } from "yaml";

export function parseYaml(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const loaded = parseYamlLib(raw, { uniqueKeys: false });
  if (loaded === null || loaded === undefined) return {};
  if (typeof loaded !== "object" || Array.isArray(loaded)) {
    throw new Error("governed YAML root must be a mapping");
  }
  return loaded as Record<string, unknown>;
}

export function frontmatterTree(raw: string): Record<string, unknown> {
  const match = FM_RE.exec(raw);
  return match ? parseYaml(match[1]) : {};
}

export function body(raw: string): string {
  return raw.replace(FM_RE, "");
}

function normalizeScalar(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

export function normalizeTree(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeTree);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) out[String(key)] = normalizeTree(child);
    return out;
  }
  return normalizeScalar(value);
}

function addMeta(out: Record<string, unknown>, path: string, value: unknown): void {
  if (!path) return;
  const v = normalizeScalar(value);
  if (!(path in out)) out[path] = v;
  else if (Array.isArray(out[path])) (out[path] as unknown[]).push(v);
  else out[path] = [out[path], v];
}

export function flattenData(value: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const dict = value as Record<string, unknown>;
    if (Object.keys(dict).length === 0 && prefix) out[prefix] = {};
    for (const [key, child] of Object.entries(dict)) {
      const childPrefix = prefix ? `${prefix}.${key}` : String(key);
      flattenData(child, childPrefix, out);
    }
  } else if (Array.isArray(value)) {
    const listPrefix = `${prefix}[]`;
    if (value.length === 0) out[listPrefix] = [];
    for (const child of value) {
      if (child && typeof child === "object") flattenData(child, listPrefix, out);
      else addMeta(out, listPrefix, child);
    }
  } else if (prefix) {
    addMeta(out, prefix, value);
  }
  return out;
}

export function mvalue(meta: Record<string, unknown>, key: string): unknown {
  const value = meta[key];
  return Array.isArray(value) && value.length > 0 ? value[0] : value;
}

function heading(raw: string): string {
  for (const line of raw.split("\n")) {
    if (line.startsWith("# ")) return line.slice(2).trim();
  }
  return "";
}

function clean(title: string, identifier = ""): string {
  let out = (title ?? "").replace(/^[A-Z]+-\d+\s*[—:-]\s*/i, "");
  if (identifier) out = out.replace(new RegExp(`^${escapeRe(identifier)}\\s*[—:-]\\s*`, "i"), "");
  return out.trim() || identifier;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findAll(text: string, re: RegExp): string[] {
  const fresh = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  const out: string[] = [];
  for (const m of text.matchAll(fresh)) out.push(m[0]);
  return out;
}

/** Stateless single match — module-level /g regexes keep lastIndex between .exec calls. */
function singleMatch(text: string, re: RegExp): RegExpExecArray | null {
  return new RegExp(re.source, re.flags.replace("g", "")).exec(text);
}

export function issues(raw: string): string[] {
  return [...new Set(findAll(raw, ISSUE_RE))].sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]));
}

function explicitRef(raw: string, label: string, pattern: string): string | null {
  const re = new RegExp(`^${escapeRe(label)}\\s*:\\s*\`?(${pattern})\`?`, "im");
  const match = re.exec(body(raw));
  return match ? match[1].toUpperCase() : null;
}

// ── Record builders ───────────────────────────────────────────────────────────

async function changed(source: ProgrammeSource, path: string, meta: Record<string, unknown>): Promise<string | null> {
  const fromMeta = mvalue(meta, "updated_at") ?? mvalue(meta, "created_at");
  if (fromMeta !== null && fromMeta !== undefined) return String(fromMeta);
  if (source.timestamp) return source.timestamp(path);
  return null;
}

async function workstreams(source: ProgrammeSource): Promise<ProgrammeWorkstream[]> {
  const result: ProgrammeWorkstream[] = [];
  const dirs = await source.listDir("workstreams");
  for (const dirPath of dirs) {
    const briefPath = `${dirPath}/BRIEF.md`;
    const briefRaw = await source.read(briefPath);
    if (briefRaw === null) continue;
    const stateRaw = await source.read(`${dirPath}/STATE.md`);
    const planRaw = await source.read(`${dirPath}/PLAN.md`);
    const briefTree = frontmatterTree(briefRaw);
    const stateTree = stateRaw !== null ? frontmatterTree(stateRaw) : {};
    const planTree = planRaw !== null ? frontmatterTree(planRaw) : {};
    const briefMeta = flattenData(briefTree);
    const stateMeta = flattenData(stateTree);
    const planMeta = flattenData(planTree);
    const dirName = dirPath.split("/").pop() ?? dirPath;
    const match = /^(WS-\d+)/.exec(dirName);
    const identifier = match ? match[1] : dirName;
    const stateStatus = singleMatch(body(stateRaw ?? ""), STATUS_RE) ?? singleMatch(body(briefRaw), STATUS_RE);
    const status = stateStatus ? stateStatus[1].trim().replace(/\.$/, "") : String(mvalue(stateMeta, "status") ?? "UNKNOWN");
    result.push({
      id: identifier,
      graph_id: identifier,
      title: clean(heading(briefRaw), identifier),
      status: status.toUpperCase(),
      path: briefPath,
      state_path: stateRaw !== null ? `${dirPath}/STATE.md` : null,
      plan_path: planRaw !== null ? `${dirPath}/PLAN.md` : null,
      has_plan: planRaw !== null,
      jira_refs: issues([briefRaw, stateRaw ?? "", planRaw ?? ""].join("\n")),
      portfolio_issue: explicitRef(briefRaw, "Jira portfolio", "ISSUE-\\d+"),
      current_assignment: explicitRef(briefRaw, "Current assignment", "(?:OPS|EXP)-\\d+"),
      updated_at: await changed(source, stateRaw !== null ? `${dirPath}/STATE.md` : briefPath, stateMeta),
      metadata: { brief: briefMeta, state: stateMeta, plan: planMeta },
      metadata_tree: { brief: normalizeTree(briefTree), state: normalizeTree(stateTree), plan: normalizeTree(planTree) },
    });
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

async function assignments(source: ProgrammeSource): Promise<ProgrammeAssignment[]> {
  const result: ProgrammeAssignment[] = [];
  const paths = await source.listDir("assignments");
  for (const path of paths) {
    if (!path.endsWith(".yaml")) continue;
    const raw = await source.read(path);
    if (raw === null) continue;
    const tree = parseYaml(raw);
    const meta = flattenData(tree);
    const nameMatch = /((?:OPS|EXP)-\d+)/i.exec(path.split("/").pop() ?? "");
    const identifier = String(mvalue(meta, "id") ?? (nameMatch ? nameMatch[1].toUpperCase() : path.split("/").pop() ?? path));
    const kind = identifier.split("-")[0].toUpperCase();
    result.push({
      id: identifier,
      graph_id: identifier,
      kind,
      title: clean(String(mvalue(meta, "title") ?? path.split("/").pop() ?? path), identifier),
      status: String(mvalue(meta, "status") ?? mvalue(meta, "state") ?? "UNKNOWN").toUpperCase(),
      authority: mvalue(meta, "authority") ?? mvalue(meta, "authority.source"),
      workstream: mvalue(meta, "workstream") ?? mvalue(meta, "related_workstreams[]"),
      jira_refs: issues(raw),
      path,
      updated_at: await changed(source, path, meta),
      identity_collision: false,
      metadata: meta,
      metadata_tree: normalizeTree(tree),
    });
  }
  const counts = new Map<string, number>();
  for (const record of result) counts.set(record.id, (counts.get(record.id) ?? 0) + 1);
  for (const record of result) {
    if ((counts.get(record.id) ?? 0) > 1) {
      record.graph_id = `assignment:${record.path}`;
      record.identity_collision = true;
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

/** Recursively collect files under `root` whose basename satisfies `matcher`.
 * listDir returns full repo-root paths; entries without an extension are treated
 * as directories and descended into. */
async function collectFiles(source: ProgrammeSource, root: string, matcher: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries: string[];
    try {
      entries = await source.listDir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = entry.split("/").pop() ?? entry;
      if (!name.includes(".")) {
        queue.push(entry);
        continue;
      }
      if (matcher(name)) out.push(entry);
    }
  }
  return out.sort();
}

async function governed(source: ProgrammeSource, patternPrefix: string, kind: string, fileMatcher: (name: string) => boolean): Promise<ProgrammeGoverned[]> {
  const result: ProgrammeGoverned[] = [];
  const paths = await collectFiles(source, patternPrefix, fileMatcher);
  for (const path of paths) {
    const name = path.split("/").pop() ?? path;
    const raw = await source.read(path);
    if (raw === null) continue;
    const tree = frontmatterTree(raw);
    const meta = flattenData(tree);
    const idMatch = singleMatch(name, ID_RE) ?? singleMatch(raw.slice(0, 1600), ID_RE);
    const identifier = String(mvalue(meta, "id") ?? (idMatch ? idMatch[0].toUpperCase() : name));
    let graphId = identifier;
    if (kind === "RESEARCH" && !CANONICAL_RESEARCH_ID_RE.test(identifier)) {
      graphId = `research:${path}`;
    }
    result.push({
      id: identifier,
      graph_id: graphId,
      title: clean(String(mvalue(meta, "title") ?? heading(raw) ?? name), identifier),
      status: String(mvalue(meta, "status") ?? "UNKNOWN").toUpperCase(),
      authority: mvalue(meta, "authority"),
      jira_refs: issues(raw),
      path,
      updated_at: await changed(source, path, meta),
      kind,
      metadata: meta,
      metadata_tree: normalizeTree(tree),
    });
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

async function agents(source: ProgrammeSource): Promise<ProgrammeAgent[]> {
  const result: ProgrammeAgent[] = [];
  const raw = await source.read("agents/registry.yaml");
  if (raw === null) return result;
  const registry = parseYaml(raw);
  const list = registry["agents"];
  if (!Array.isArray(list)) return result;
  const registryMeta = flattenData(registry);
  for (const actor of list) {
    if (!actor || typeof actor !== "object" || Array.isArray(actor)) continue;
    const entry = actor as Record<string, unknown>;
    const meta = flattenData(entry);
    const identifier = String(entry["id"] ?? "unknown-agent");
    const contract = entry["contract"];
    const path = typeof contract === "string" ? contract : "agents/registry.yaml";
    result.push({
      id: identifier,
      graph_id: identifier,
      title: String(entry["role"] ?? identifier),
      status: String(entry["status"] ?? "UNKNOWN").toUpperCase(),
      role: String(entry["role"] ?? "programme actor"),
      path,
      updated_at: await changed(source, "agents/registry.yaml", registryMeta),
      metadata: meta,
      metadata_tree: normalizeTree(actor),
    });
  }
  return result;
}

async function programmeRefs(source: ProgrammeSource): Promise<{ refs: ProgrammeRef[]; operator: string[] }> {
  const seen = new Map<string, Set<string>>();
  const operator = new Set<string>();
  const allPaths = await walkAll(source);
  for (const path of allPaths) {
    const raw = await source.read(path);
    if (raw === null) continue;
    for (const ref of issues(raw)) {
      const set = seen.get(ref) ?? new Set<string>();
      set.add(path);
      seen.set(ref, set);
    }
    const name = path.split("/").pop() ?? "";
    if (name === "operator-input-request.md" || name.toLowerCase().includes("operator-input")) {
      for (const ref of issues(raw)) operator.add(ref);
    }
  }
  const order = [...seen.keys()].sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]));
  return {
    refs: order.map((key) => ({ key, seen_in: [...(seen.get(key) ?? [])].sort() })),
    operator: [...operator].sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1])),
  };
}

async function walkAll(source: ProgrammeSource): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const interesting = new Set([".md", ".yaml", ".yml", ".json"]);
  const skipDirs = new Set([".git", "dashboard", ".xtrm", ".pi", ".beads", "node_modules", ".claude", ".github"]);
  const queue = [""];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries: string[];
    try {
      entries = await source.listDir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      const name = entry.split("/").pop() ?? "";
      if (name.startsWith(".")) continue;
      const isDir = name === "" || !name.includes(".");
      if (isDir) {
        if (!skipDirs.has(name)) queue.push(entry);
        continue;
      }
      const dot = name.lastIndexOf(".");
      const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
      if (interesting.has(ext)) out.push(entry);
    }
  }
  return out.sort();
}

// ── Business / NOW ────────────────────────────────────────────────────────────

async function business(source: ProgrammeSource): Promise<ProgrammeBusiness> {
  const path = "workstreams/WS-009-mercury-business-continuity-growth/PLAN.md";
  const raw = await source.read(path);
  const out: ProgrammeBusiness = { source: raw !== null ? path : null };
  if (raw === null) return out;
  let target: number | null = null;
  let deadline: string | null = null;
  let m = /Primary objective:\s*(\w+(?:-\w+)?)\s+cumulative paid programme customers by\s+(\d{4}-\d{2}-\d{2})/i.exec(raw);
  if (m) {
    target = WORDS[m[1].toLowerCase()] ?? null;
    deadline = m[2];
  }
  if (target === null) {
    m = /\b(\d+)\s+cumulative paid programme customers by\s+(\d{4}-\d{2}-\d{2})/i.exec(raw);
    if (m) {
      target = Number(m[1]);
      deadline = m[2];
    }
  }
  const b = /Initial operator baseline:\s*(\w+(?:-\w+)?)\s+customers/i.exec(raw);
  out.target_customers = target;
  out.deadline = deadline;
  out.baseline_customers = b ? (WORDS[b[1].toLowerCase()] ?? null) : null;
  out.evidence_note = "Operator baseline until reconciled against the authoritative sales/payment source.";
  return out;
}

async function now(source: ProgrammeSource): Promise<{ title: string; evidence_cutoff: string | null; path: string }> {
  const raw = await source.read("NOW.md");
  if (raw === null) return { title: "", evidence_cutoff: null, path: "NOW.md" };
  const m = /^Evidence cutoff:\s*(.+)$/m.exec(raw);
  return { title: heading(raw), evidence_cutoff: m ? m[1].trim() : null, path: "NOW.md" };
}

// ── Graph ─────────────────────────────────────────────────────────────────────

function inferKind(identifier: string): string {
  const upper = identifier.toUpperCase();
  if (upper.startsWith("WS-")) return "workstream";
  if (upper.startsWith("OPS-") || upper.startsWith("EXP-")) return "assignment";
  if (upper.startsWith("RESEARCH-")) return "research";
  if (upper.startsWith("ADR-")) return "decision";
  if (upper.startsWith("PROP-")) return "proposal";
  if (upper.startsWith("ISSUE-")) return "jira";
  if (identifier.includes("/") && !/(\.md|\.yaml|\.json)$/i.test(identifier)) return "repository";
  return "actor";
}

function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/** Embedded records declare their own subject (actor_id/id differing from the
 * outer record's id); their nested relation fields are not attributed to the
 * outer entity. Mirrors dashboard/build_snapshot.py embedded_subject(). */
function embeddedSubject(flat: Record<string, unknown>, path: string, outerId: string): boolean {
  if (!path.includes(".")) return false;
  const prefix = path.slice(0, path.lastIndexOf("."));
  for (const key of [`${prefix}.id`, `${prefix}.actor_id`]) {
    const value = mvalue(flat, key);
    if (value !== null && value !== undefined && String(value) !== String(outerId)) return true;
  }
  return false;
}

const RELATION_FIELDS: Record<string, string> = {
  workstream: "workstream",
  "related_workstreams[]": "workstream",
  portfolio_issue: "portfolio",
  dispatch_issue: "dispatch",
  jira_epic: "portfolio",
  operator_input_issue: "operator_input",
  identity_and_notification_issue: "portfolio",
  "related_jira[]": "portfolio",
  owner: "owner",
  created_by: "created_by",
  assigned_role: "assigned_role",
  parent: "parent",
  projection_of: "projection_of",
  current_projection: "current_projection",
  predecessor: "predecessor",
  supersedes: "supersedes",
  superseded_by: "superseded_by",
  decision: "decision",
  assignment: "assignment",
  current_assignment: "assignment",
  hive_head_assignment: "assignment",
  source_repository: "repository",
  target_repository: "repository",
};

interface GraphBuilder {
  nodes: Map<string, ProgrammeNode>;
  edges: ProgrammeEdge[];
  seenEdges: Set<string>;
  collisions: IdentityCollision[];
}

function graphFrom(
  workstreamRecords: ProgrammeWorkstream[],
  assignmentRecords: ProgrammeAssignment[],
  researchRecords: ProgrammeGoverned[],
  decisionRecords: ProgrammeGoverned[],
  proposalRecords: ProgrammeGoverned[],
  actorRecords: ProgrammeAgent[],
): { graph: ProgrammeGraph; collisions: IdentityCollision[] } {
  const g: GraphBuilder = { nodes: new Map(), edges: [], seenEdges: new Set(), collisions: [] };

  const assignmentCounts = new Map<string, number>();
  for (const record of assignmentRecords) assignmentCounts.set(record.id, (assignmentCounts.get(record.id) ?? 0) + 1);
  const collisions: IdentityCollision[] = [];
  for (const [identifier, count] of assignmentCounts) {
    if (count > 1) {
      collisions.push({
        id: identifier,
        kind: "assignment",
        records: assignmentRecords.filter((r) => r.id === identifier).map((r) => r.path).sort(),
      });
    }
  }

  const ensure = (
    identifier: unknown,
    kind?: string,
    title?: string,
    status?: string,
    path?: string,
    metadata?: Record<string, unknown>,
    metadataTree?: unknown,
  ): void => {
    if (!identifier) return;
    const id = String(identifier);
    let node = g.nodes.get(id);
    if (!node) {
      node = {
        id,
        kind: kind ?? inferKind(id),
        title: title ?? id,
        status,
        source_path: path,
        metadata: metadata ?? {},
        metadata_tree: metadataTree ?? {},
      };
      g.nodes.set(id, node);
    } else if (node.kind === "collision" && kind !== "collision") {
      return;
    }
    if (kind) node.kind = kind;
    if (title) node.title = title;
    if (status) node.status = status;
    if (path) node.source_path = path;
    if (metadata !== undefined) node.metadata = metadata;
    if (metadataTree !== undefined) node.metadata_tree = metadataTree;
  };

  const edge = (source: unknown, target: unknown, relation: string, field: string, strength: "strong" | "weak" = "strong"): void => {
    if (!source || !target || String(source) === String(target)) return;
    const s = String(source);
    const t = String(target);
    ensure(s);
    ensure(t);
    const key = `${s}\u001f${t}\u001f${relation}`;
    if (g.seenEdges.has(key)) return;
    g.seenEdges.add(key);
    g.edges.push({ source: s, target: t, relation, field, strength });
  };

  interface CollectionRecord {
    graph_id?: string;
    id: string;
    title: string;
    status?: string;
    path: string;
    metadata: Record<string, unknown>;
    metadata_tree: unknown;
    jira_refs?: string[];
  }
  const collections: Array<{ records: CollectionRecord[]; kind: string }> = [
    { records: workstreamRecords, kind: "workstream" },
    { records: assignmentRecords, kind: "assignment" },
    { records: researchRecords, kind: "research" },
    { records: decisionRecords, kind: "decision" },
    { records: proposalRecords, kind: "proposal" },
    { records: actorRecords, kind: "actor" },
  ];

  for (const collision of collisions) {
    ensure(collision.id, "collision", `${collision.id} — ${collision.records.length} assignment records`, "ID COLLISION", undefined, { "records[]": collision.records }, { records: collision.records });
  }

  for (const { records, kind } of collections) {
    for (const record of records) {
      const graphId = record.graph_id ?? record.id;
      ensure(graphId, kind, record.title, record.status, record.path, record.metadata, record.metadata_tree);
      if (kind === "assignment" && graphId !== record.id) edge(record.id, graphId, "ambiguous_id", "assignment.id");
      if (kind === "research" && graphId !== record.id) edge(record.id, graphId, "evidence_artifact", "frontmatter.id");
    }
  }

  for (const record of workstreamRecords) {
    if (record.current_assignment) edge(record.graph_id, record.current_assignment, "current_assignment", "BRIEF.Current assignment");
    if (record.portfolio_issue) edge(record.graph_id, record.portfolio_issue, "portfolio", "BRIEF.Jira portfolio");
  }

  const NO_REFS_ACTOR_RELATIONS = new Set(["owner", "created_by", "assigned_role", "parent", "projection_of", "current_projection"]);
  const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

  for (const { records, kind } of collections) {
    for (const record of records) {
      const source = record.graph_id ?? record.id;
      const metadata = record.metadata ?? {};
      const groups: Array<[string, Record<string, unknown>]> = kind === "workstream"
        ? Object.entries(metadata) as Array<[string, Record<string, unknown>]>
        : [["metadata", metadata]];
      const strongTargets = new Set<string>();
      for (const [group, flat] of groups) {
        if (!flat || typeof flat !== "object" || Array.isArray(flat)) continue;
        for (const [path, rawValue] of Object.entries(flat)) {
          const suffix = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : path;
          let relation: string | undefined;
          for (const [key, rel] of Object.entries(RELATION_FIELDS)) {
            if (path === key || path.endsWith("." + key) || suffix === key) {
              relation = rel;
              break;
            }
          }
          if (embeddedSubject(flat, path, record.id)) continue;
          for (const raw of values(rawValue)) {
            if (raw === null || raw === undefined) continue;
            const text = String(raw);
            const refs = new Set<string>();
            for (const m of findAll(text.toUpperCase(), ID_RE)) refs.add(m);
            for (const m of findAll(text.toUpperCase(), ISSUE_RE)) refs.add(m);

            if (relation && NO_REFS_ACTOR_RELATIONS.has(relation) && refs.size === 0) {
              const target = text.trim();
              if (target && target.length < 120 && !target.includes(" ")) {
                ensure(target, "actor");
                if (relation === "parent") edge(target, source, "parent", `${group}.${path}`);
                else if (relation === "projection_of") edge(target, source, "projection", `${group}.${path}`);
                else if (relation === "current_projection") edge(source, target, "projection", `${group}.${path}`);
                else edge(target, source, relation, `${group}.${path}`);
                strongTargets.add(target);
              }
            }

            if (relation === "repository") {
              const target = text.trim();
              if (REPOSITORY_RE.test(target)) {
                ensure(target, "repository");
                edge(source, target, "repository", `${group}.${path}`);
                strongTargets.add(target);
              }
            }

            for (const ref of [...refs].sort()) {
              const target = ref.toUpperCase();
              if (relation === "workstream") edge(target, source, "contains", `${group}.${path}`);
              else if (relation === "predecessor") edge(target, source, "precedes", `${group}.${path}`);
              else if (relation === "supersedes") edge(target, source, "superseded_by", `${group}.${path}`);
              else if (relation === "superseded_by") edge(source, target, "superseded_by", `${group}.${path}`);
              else if (relation === "decision") edge(target, source, "authorizes", `${group}.${path}`);
              else if (relation === "assignment") edge(source, target, "assignment", `${group}.${path}`);
              else if (relation === "projection_of") edge(target, source, "projection", `${group}.${path}`);
              else if (relation === "current_projection") edge(source, target, "projection", `${group}.${path}`);
              else if (relation) edge(source, target, relation, `${group}.${path}`);
              else edge(source, target, "references", `${group}.${path}`, "weak");
              if (relation) strongTargets.add(target);
            }
          }
        }
      }
      for (const target of record.jira_refs ?? []) {
        if (!strongTargets.has(target)) edge(source, target, "references", "body/reference", "weak");
      }
    }
  }

  const metadataCounts = new Map<string, number>();
  for (const { records, kind } of collections) {
    for (const record of records) {
      const groups: Array<Record<string, unknown>> = kind === "workstream"
        ? Object.values(record.metadata ?? {}) as Array<Record<string, unknown>>
        : [(record.metadata ?? {})];
      for (const flat of groups) {
        if (flat && typeof flat === "object" && !Array.isArray(flat)) {
          for (const key of Object.keys(flat)) metadataCounts.set(key, (metadataCounts.get(key) ?? 0) + 1);
        }
      }
    }
  }

  const nodes = [...g.nodes.values()].sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind)));
  return {
    graph: {
      nodes,
      edges: g.edges,
      metadata_fields: [...metadataCounts.entries()]
        .sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1]))
        .map(([path, records]) => ({ path, records })),
      identity_collisions: collisions,
    },
    collisions,
  };
}

// ── State / Journal / Publication enrichment ─────────────────────────────────

async function loadStates(source: ProgrammeSource): Promise<StateRecord[]> {
  const out: StateRecord[] = [];
  for (const path of await collectFiles(source, "state", (name) => name.endsWith(".json"))) {
    const raw = await source.read(path);
    if (raw === null) continue;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const d = data as Record<string, unknown>;
    const name = path.split("/").pop() ?? path;
    const stem = name.replace(/\.json$/, "");
    out.push({
      id: `state:${stem}`,
      kind: "state",
      title: stem.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      status: String(d["status"] ?? d["mode"] ?? "UNKNOWN").toUpperCase(),
      actor_id: d["actor_id"] !== undefined && d["actor_id"] !== null ? String(d["actor_id"]) : null,
      assignment_id: d["assignment_id"] !== undefined && d["assignment_id"] !== null ? String(d["assignment_id"]) : null,
      updated_at: d["updated_at"] !== undefined && d["updated_at"] !== null ? String(d["updated_at"]) : null,
      path,
      metadata_tree: data,
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function loadJournals(source: ProgrammeSource): Promise<JournalRecord[]> {
  const out: JournalRecord[] = [];
  const paths = await collectFiles(source, "journals", (name) => name.endsWith(".md"));
  for (const path of paths) {
    const raw = await source.read(path);
    if (raw === null) continue;
    const rel = path;
    const name = path.split("/").pop() ?? path;
    const isOperator = rel.startsWith("journals/operator/");
    const title = heading(raw) || name.replace(/\.md$/, "");
    const dateMatch = /^Date:\s*(.+)$/im.exec(raw);
    let date: string | null = null;
    if (dateMatch) {
      const v = dateMatch[1].trim();
      if (/^\d{4}-\d{2}-\d{2}/.test(v)) date = v.slice(0, 10);
    }
    if (!date) {
      const stemMatch = /(\d{4}-\d{2}-\d{2})/.exec(name);
      date = stemMatch ? stemMatch[1] : null;
    }
    const cutoff = /^Evidence cutoff:\s*(.+)$/im.exec(raw);
    const classification = /^Run classification:\s*(.+)$/im.exec(raw);
    const publication = /^Publication:\s*(.+)$/im.exec(raw);
    out.push({
      id: `journal:${rel.replace(/\.md$/, "")}`,
      kind: "journal",
      title,
      date,
      evidence_cutoff: cutoff ? cutoff[1].trim() : null,
      classification: classification ? classification[1].trim() : null,
      publication: publication ? publication[1].trim() : null,
      authority_class: isOperator ? "non_authoritative_operator_observation" : "operational_evidence_history",
      refs: [...new Set(findAll(raw.toUpperCase(), ID_RE))].sort(),
      path: rel,
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function publications(states: StateRecord[]): PublicationRecord[] {
  const out: PublicationRecord[] = [];
  const coordinator = states.find((s) => s.id === "state:coordinator");
  if (!coordinator) return out;
  const d = coordinator.metadata_tree as Record<string, unknown>;
  const slots = ["last_successful_run", "last_accepted_run", "last_completed_run", "last_reviewed_run"];
  for (const slot of slots) {
    const r = d[slot];
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const run = r as Record<string, unknown>;
    const runDate = run["run_date"];
    if (runDate === undefined || runDate === null) continue;
    const review = run["review"] ?? run["review_status"] ?? run["review_verdict"];
    if (!(run["branch"] !== undefined && run["branch"] !== null) && !(run["pull_request"] !== undefined && run["pull_request"] !== null) && review === undefined) continue;
    out.push({
      id: `publication:${runDate}:${slot}`,
      kind: "publication",
      title: `${runDate} · ${slot.replace(/_/g, " ")}`,
      run_date: String(runDate),
      slot,
      assignment_id: run["assignment_id"] !== undefined && run["assignment_id"] !== null ? String(run["assignment_id"]) : null,
      branch: run["branch"] !== undefined && run["branch"] !== null ? String(run["branch"]) : null,
      pull_request: run["pull_request"] !== undefined && run["pull_request"] !== null ? String(run["pull_request"]) : null,
      review,
      execution_status: run["execution_status"],
      source_path: coordinator.path,
      evidence_class: "wrapper_recorded_state",
      logical_actor: "UNKNOWN",
      principal_set: "UNKNOWN",
    });
  }
  return out;
}

function refreshBusiness(business: ProgrammeBusiness, stateRaw: string | null): void {
  if (stateRaw === null) return;
  const m = /^\|\s*cumulative paid programme customers\s*\|\s*([A-Z_]+)\s*\|\s*.*?:\s*(\d+)\s*\|/im.exec(stateRaw);
  if (!m) return;
  business.baseline_customers = Number(m[2]);
  business.baseline_evidence_class = m[1].toUpperCase();
  business.baseline_source = "workstreams/WS-009-mercury-business-continuity-growth/STATE.md";
  business.evidence_note = `Current customer baseline is ${m[1].toUpperCase()} programme evidence from WS-009 STATE; authoritative payment/sales reconciliation remains required.`;
}

function addNode(nodes: ProgrammeNode[], node: ProgrammeNode): void {
  if (!nodes.some((x) => x.id === node.id)) nodes.push(node);
}

function addEdge(edges: ProgrammeEdge[], edge: ProgrammeEdge): void {
  const key = [edge.source, edge.target, edge.relation, edge.field].join("\u001f");
  if (!edges.some((x) => [x.source, x.target, x.relation, x.field].join("\u001f") === key)) edges.push(edge);
}

export function enrichGraph(
  graph: ProgrammeGraph,
  states: StateRecord[],
  journals: JournalRecord[],
  pubs: PublicationRecord[],
): number {
  for (const state of states) {
    addNode(graph.nodes, {
      id: state.id,
      kind: "state",
      title: state.title,
      status: state.status,
      source_path: state.path,
      metadata: { actor_id: state.actor_id, assignment_id: state.assignment_id, updated_at: state.updated_at },
      metadata_tree: state.metadata_tree,
    });
    if (state.actor_id) addEdge(graph.edges, { source: state.actor_id, target: state.id, relation: "materializes_state", field: "state.actor_id", strength: "strong" });
    if (state.assignment_id) addEdge(graph.edges, { source: state.assignment_id, target: state.id, relation: "state_snapshot", field: "state.assignment_id", strength: "strong" });
  }
  for (const journal of journals) {
    addNode(graph.nodes, {
      id: journal.id,
      kind: "journal",
      title: journal.title,
      status: journal.classification ?? journal.authority_class,
      source_path: journal.path,
      metadata: { date: journal.date, evidence_cutoff: journal.evidence_cutoff, authority_class: journal.authority_class, publication: journal.publication },
      metadata_tree: journal,
    });
  }
  const coordinator = states.find((s) => s.id === "state:coordinator");
  const runDates = new Set<string>();
  if (coordinator) {
    const d = coordinator.metadata_tree as Record<string, unknown>;
    for (const slot of ["last_successful_run", "last_accepted_run", "last_completed_run", "last_reviewed_run"]) {
      const r = d[slot];
      if (r && typeof r === "object" && !Array.isArray(r) && (r as Record<string, unknown>)["run_date"] !== undefined) {
        runDates.add(String((r as Record<string, unknown>)["run_date"]));
      }
    }
  }
  for (const journal of journals) {
    if (journal.date && runDates.has(journal.date)) {
      addEdge(graph.edges, { source: journal.id, target: "state:coordinator", relation: "paired_run_output", field: "journal.date == coordinator.run_date", strength: "strong" });
    }
  }
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  for (const pub of pubs) {
    addNode(graph.nodes, {
      id: pub.id,
      kind: "publication",
      title: pub.title,
      status: String(pub.execution_status ?? pub.review ?? "RECORDED"),
      source_path: pub.source_path,
      metadata: {
        branch: pub.branch,
        pull_request: pub.pull_request,
        review: pub.review,
        evidence_class: pub.evidence_class,
        logical_actor: "UNKNOWN",
        principal_set: "UNKNOWN",
      },
      metadata_tree: pub,
    });
    addEdge(graph.edges, { source: "state:coordinator", target: pub.id, relation: "records_publication", field: `state.coordinator.${pub.slot}`, strength: "strong" });
    const journal = journals.find((q) => q.date === pub.run_date);
    if (journal) addEdge(graph.edges, { source: journal.id, target: pub.id, relation: "publication_facts", field: "wrapper publication receipt", strength: "strong" });
    if (pub.assignment_id && nodeIds.has(pub.assignment_id)) {
      addEdge(graph.edges, { source: pub.assignment_id, target: pub.id, relation: "published_run", field: "publication.assignment_id", strength: "strong" });
    }
  }
  graph.nodes.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind)));
  graph.edges.sort((a, b) =>
    a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.relation.localeCompare(b.relation) || (a.field ?? "").localeCompare(b.field ?? "") || a.strength.localeCompare(b.strength),
  );
  return 0;
}

export function provenanceFrom(states: StateRecord[], pubs: PublicationRecord[]): ProgrammeProvenance {
  return {
    current: {
      programme_actor_registry: true,
      state_actor_assignment_fields: states.some((s) => s.actor_id || s.assignment_id),
      wrapper_publication_facts: pubs.length > 0,
      xtrm_mutation_receipts: false,
    },
    rules: [
      "Never infer a logical actor from a GitHub/Jira username, prose, branch name, label, or model name.",
      "Never infer a credential principal from a logical actor.",
      "Publication facts recorded by wrapper-owned state remain distinct from AI-authored journal/state content.",
      "Future XTRM provenance receipts may bind actor, principal set, execution, assignment/version, authority, content hash, and external object reference only after that contract is canonical.",
    ],
    live_receipt_gate: "ISSUE-87 plus an accepted canonical XTRM identity/provenance contract",
  };
}

// ── Orchestration ─────────────────────────────────────────────────────────────

export async function buildProgrammeSnapshot(source: ProgrammeSource, generatedAt = new Date().toISOString()): Promise<ProgrammeSnapshot> {
  const [ws, asg, research, decisions, proposals, actors, refsResult, biz, nowDoc, activity] = await Promise.all([
    workstreams(source),
    assignments(source),
    governed(source, "research", "RESEARCH", (n) => n.endsWith(".md")),
    governed(source, "decisions", "ADR", (n) => n.startsWith("ADR-") && n.endsWith(".md")),
    governed(source, "proposals", "PROP", (n) => n.startsWith("PROP-") && n.endsWith(".md")),
    agents(source),
    programmeRefs(source),
    business(source),
    now(source),
    source.recentCommits(25),
  ]);

  const graphResult = graphFrom(ws, asg, research, decisions, proposals, actors);

  const headSha = activity.length > 0 ? activity[0].sha : null;
  return {
    schema_version: 2,
    generated_at: generatedAt,
    programme: { repository: source.repository, branch: source.branch, sha: headSha, short_sha: headSha ? headSha.slice(0, 7) : null },
    now: nowDoc,
    business: biz,
    workstreams: ws,
    assignments: asg,
    research,
    decisions,
    proposals,
    agents: actors,
    jira_refs: refsResult.refs,
    operator_input_refs: refsResult.operator,
    activity,
    graph: graphResult.graph,
    identity_collisions: graphResult.collisions,
    evidence_boundary: {
      beads: "not inferred: repository-local Beads require a fresh local read or governed board-audit transport",
      runtime: "not inferred: deployment/production state requires current operational evidence",
      jira: "programme references are build-time; live status is optional through an authorized server-side read-only Jira adapter",
    },
  } as unknown as ProgrammeSnapshot;
}

export async function enrichProgrammeSnapshot(snapshot: ProgrammeSnapshot, source: ProgrammeSource): Promise<ProgrammeSnapshot> {
  const states = await loadStates(source);
  const journals = await loadJournals(source);
  const pubs = publications(states);
  const stateRaw = await source.read("workstreams/WS-009-mercury-business-continuity-growth/STATE.md");
  refreshBusiness(snapshot.business, stateRaw);
  enrichGraph(snapshot.graph, states, journals, pubs);
  snapshot.base_schema_version = snapshot.schema_version;
  snapshot.schema_version = 3;
  snapshot.state_records = states;
  snapshot.journals = journals;
  snapshot.publication_facts = pubs;
  snapshot.state_history_semantics = {
    current_state_precedence: "current accepted STATE evidence supersedes historical PLAN baseline for mutable observations",
    journal_authority: "journals are evidence/history; journals do not silently establish programme authority",
    publication_separation: "AI-produced journal/state content is distinct from wrapper-recorded branch/PR/publication facts",
    unsafe_nested_relationship_policy: "nested relationship-like metadata inside an embedded record with its own actor_id/id is not attributed to the outer entity",
    suppressed_unsafe_nested_edges: 0,
  };
  snapshot.provenance = provenanceFrom(states, pubs);
  return snapshot;
}

/** Re-index a node set so every edge endpoint exists (defensive; the builder
 * and enrichment both ensure endpoints, this guards future additions). */
export function assertNoDanglingEdges(graph: ProgrammeGraph): void {
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const edge of graph.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      throw new Error(`dangling edge ${edge.source} -> ${edge.target} (${edge.relation})`);
    }
  }
}
