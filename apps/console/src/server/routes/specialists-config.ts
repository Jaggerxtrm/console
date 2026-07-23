import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { Hono } from "hono";
import { makeLogEntry, type LogEntry } from "../../../../../packages/core/src/runtime/index.ts";
import { isAllowedConsoleWriteRequest, isLoopbackAddress, isLocalhost } from "../../../../../packages/core/src/runtime/console-write-policy.ts";

const SPECIALISTS_SUBDIR = "specialists";
const USER_CONFIG_FILENAME = "user.json";
const CONSOLE_CONFIG_FILENAME = "console.json";
const CONSOLE_CONFIG_DOC = "./console-config-guide.md";
const CONSOLE_CONFIG_SCHEMA_VERSION = 1;
const CATALOG_PATH = ".specialists/catalog/index.json";
const DEFAULT_BASE_DIR_CANDIDATES = ["~/dev", "~/projects", "~/work", "~/repos", "~/code"] as const;
const MAX_SCAN_DEPTH = 2;
const LEAF_FIELDS = [
  "execution.model",
  "execution.fallback_model",
  "execution.fallback_models",
  "execution.timeout_ms",
  "execution.stall_timeout_ms",
  "execution.interactive",
  "execution.thinking_level",
  "execution.max_retries",
  "execution.prompt_limit_bytes",
  "execution.stdout_limit_bytes",
  "execution.extensions.serena",
  "execution.extensions.gitnexus",
  "prompt.system_prompt_mode",
  "stall_detection.waiting_auto_close_ms",
  "beads_write_notes",
  "notes_mode",
  "output_file",
  "skills.paths",
] as const;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const SYSTEM_PROMPT_MODES = new Set(["append", "replace"]);
const NOTES_MODES = new Set(["full-trail", "final-only"]);

type LeafPath = (typeof LEAF_FIELDS)[number];
type ConsoleConfigSource = "xdg" | "config-home" | "legacy";
type UserMutationOp = "set" | "append" | "remove";
type ConsoleMutationAction = "addRepo" | "removeRepo" | "editRepo" | "addBaseDir" | "removeBaseDir" | "rescan";

type RunCommand = (command: string, args: string[], cwd?: string) => { ok: boolean; stdout: string; stderr: string; status: number | null };

type ConsoleRepoEntry = { name: string; path: string };
type ConsoleConfig = { _doc?: string; schema_version: number; base_dirs: string[]; repos: ConsoleRepoEntry[]; auto_discovered_at?: string };
type ValidationError = { path: string; message: string };

type CatalogEntry = { name: string };

type UserMutationBody = {
  specialist: string;
  path: LeafPath;
  op: UserMutationOp;
  value?: unknown;
  expectedMtimeMs?: number;
};

type ConsoleMutationBody = {
  action: ConsoleMutationAction;
  expectedMtimeMs?: number;
  repo?: { name: string; path: string };
  previousName?: string;
  field?: "name" | "path";
  value?: string;
  baseDir?: string;
};

export interface SpecialistsConfigRouterOptions {
  runCommand?: RunCommand;
  now?: () => number;
  catalogPath?: string;
  emit?: (entry: LogEntry) => void;
}

export function createSpecialistsConfigRouter(options: SpecialistsConfigRouterOptions = {}): Hono {
  const router = new Hono();
  const runCommand = options.runCommand ?? defaultRunCommand;
  const now = options.now ?? (() => Date.now());
  const catalogPath = options.catalogPath ?? CATALOG_PATH;
  const log = options.emit ?? (() => {});

  router.get("/", async (c) => {
    if (!isReadAllowed(c)) return c.json({ error: "forbidden" }, 403);
    const specialists = readSpecialistsCatalog(catalogPath, runCommand);
    const userPath = getSpecialistsConfigPath(USER_CONFIG_FILENAME);
    const consolePath = getSpecialistsConfigPath(CONSOLE_CONFIG_FILENAME);
    const rawUser = readJsonFile(userPath.path);
    const userErrors = rawUser.ok ? validateGlobalUserConfig(rawUser.value) : rawUser.error ? [{ path: "json", message: rawUser.error }] : [];
    const consoleConfig = readConsoleConfig();

    log(makeLogEntry("api", "specialists.config", "info", "read specialists config", {
      action: "read",
      specialists: specialists.length,
      userExists: userPath.exists,
      consoleExists: consolePath.exists,
    }));

    return c.json({
      host: { label: "Host-wide config", scope: "global" },
      specialists,
      userConfig: {
        path: userPath.path,
        displayPath: displayPath(userPath.path),
        source: userPath.source,
        exists: userPath.exists,
        mtimeMs: statConfigFileMtimeMs(userPath.path),
        content: rawUser.ok ? rawUser.value : {},
        validationErrors: userErrors,
        leafPaths: LEAF_FIELDS,
      },
      consoleConfig: {
        path: consolePath.path,
        displayPath: displayPath(consolePath.path),
        source: consolePath.source,
        exists: consolePath.exists,
        mtimeMs: statConfigFileMtimeMs(consolePath.path),
        content: consoleConfig ?? buildConsoleConfigTemplate([], [], new Date(now()).toISOString()),
      },
    });
  });

  router.patch("/user", async (c) => {
    if (!isWriteAllowed(c)) return c.json({ error: "forbidden" }, 403);
    const body = await safeJson<UserMutationBody>(c.req.raw);
    if (!body) return c.json({ error: "invalid json" }, 400);
    const guard = validateUserMutationBody(body);
    if (guard) return c.json({ error: guard }, 400);

    const pathInfo = getSpecialistsConfigPath(USER_CONFIG_FILENAME);
    const current = readJsonFile(pathInfo.path);
    if (!current.ok && current.error) return c.json({ error: current.error }, 400);
    const currentObject = isRecord(current.value) ? current.value : {};
    const candidate = applyUserMutation(currentObject, body);
    const validation = validateGlobalUserConfig(candidate);
    if (validation.length > 0) return c.json({ error: "schema_invalid", validationErrors: validation }, 422);
    const safeWrite = writeGlobalConfigSafe(candidate, pathInfo.path, body.expectedMtimeMs);
    if (!safeWrite.ok) {
      if (safeWrite.errorClass === "mtime_mismatch") return c.json({ error: "mtime_mismatch", mtimeMs: statConfigFileMtimeMs(pathInfo.path) }, 409);
      return c.json({ error: safeWrite.errorClass ?? "write_failed", validationErrors: safeWrite.errors ?? [] }, 422);
    }
    const cli = runSpEdit(body, runCommand);
    if (!cli.ok) {
      writeGlobalConfigSafe(currentObject, pathInfo.path);
      return c.json({ error: "sp_edit_failed", detail: cli.stderr || cli.stdout || `sp exited ${cli.status ?? -1}` }, 500);
    }

    log(makeLogEntry("api", "specialists.config", "info", "updated specialists user config", {
      action: "user.write",
      specialist: body.specialist,
      path: body.path,
      op: body.op,
    }));
    return c.json({ ok: true, mtimeMs: statConfigFileMtimeMs(pathInfo.path), content: candidate });
  });

  router.patch("/console", async (c) => {
    if (!isWriteAllowed(c)) return c.json({ error: "forbidden" }, 403);
    const body = await safeJson<ConsoleMutationBody>(c.req.raw);
    if (!body) return c.json({ error: "invalid json" }, 400);
    const current = readConsoleConfig() ?? buildConsoleConfigTemplate([], [], new Date(now()).toISOString());
    const updated = applyConsoleMutation(current, body, now);
    if (!updated.ok) return c.json({ error: updated.error }, updated.status);
    const safeWrite = writeGlobalConfigSafe(updated.value, getSpecialistsConfigPath(CONSOLE_CONFIG_FILENAME).path, body.expectedMtimeMs, validateConsoleConfig);
    if (!safeWrite.ok) {
      if (safeWrite.errorClass === "mtime_mismatch") return c.json({ error: "mtime_mismatch", mtimeMs: statConfigFileMtimeMs(getSpecialistsConfigPath(CONSOLE_CONFIG_FILENAME).path) }, 409);
      return c.json({ error: safeWrite.errorClass ?? "write_failed", validationErrors: safeWrite.errors ?? [] }, 422);
    }

    log(makeLogEntry("api", "specialists.config", "info", "updated console repo registry", {
      action: `console.${body.action}`,
      repos: updated.value.repos.length,
      baseDirs: updated.value.base_dirs.length,
    }));
    return c.json({ ok: true, mtimeMs: statConfigFileMtimeMs(getSpecialistsConfigPath(CONSOLE_CONFIG_FILENAME).path), content: updated.value });
  });

  return router;
}

function isReadAllowed(c: { req: { url: string; raw: Request } }): boolean {
  const host = c.req.raw.headers.get("host") ?? "";
  const origin = c.req.raw.headers.get("origin");
  if (!origin) return isLocalConfigHost(c.req.url, host, c.req.raw.headers.get("x-xtrm-peer-address"));
  return isWriteAllowed(c);
}

function isWriteAllowed(c: { req: { url: string; raw: Request } }): boolean {
  return isAllowedConsoleWriteRequest(
    c.req.url,
    c.req.raw.headers.get("host") ?? "",
    c.req.raw.headers.get("origin"),
    c.req.raw.headers.get("x-console-write-token") ?? c.req.raw.headers.get("x-gitboard-sources-admin-token"),
    process.env,
    c.req.raw.headers.get("x-xtrm-peer-address"),
  );
}

function isLocalConfigHost(url: string, host: string, peerAddress: string | null): boolean {
  try {
    const allowedHosts = new Set(["localhost", "127.0.0.1", "::1"]);
    const configuredHost = normalizeConfigHost(process.env.HOST);
    if (configuredHost && configuredHost !== "0.0.0.0") allowedHosts.add(configuredHost);

    const requestUrl = new URL(url);
    const hostname = normalizeConfigHost(requestUrl.hostname);
    const hostName = normalizeConfigHost(new URL(host.includes("://") ? host : `http://${host}`).hostname);
    if (peerAddress && (isLocalhost(host) || isLocalhost(requestUrl.hostname)) && !isLoopbackAddress(peerAddress)) return false;
    return Boolean(hostname && hostName && allowedHosts.has(hostname) && allowedHosts.has(hostName));
  } catch {
    return false;
  }
}

function normalizeConfigHost(host: string | undefined | null): string | null {
  if (!host) return null;
  const trimmed = host.trim();
  if (!trimmed) return null;
  return trimmed === "[::1]" ? "::1" : trimmed;
}

function defaultRunCommand(command: string, args: string[], cwd?: string) {
  const child = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
  return { ok: child.status === 0, stdout: child.stdout ?? "", stderr: child.stderr ?? "", status: child.status };
}

function readSpecialistsCatalog(catalogPath: string, runCommand: RunCommand): CatalogEntry[] {
  const file = readJsonFile(catalogPath);
  if (file.ok) return normalizeCatalog(file.value);
  const command = process.env.GITBOARD_SP_BIN || "sp";
  const result = runCommand(command, ["list", "--json"]);
  if (!result.ok) return [];
  try {
    return normalizeCatalog(JSON.parse(result.stdout));
  } catch {
    return [];
  }
}

function normalizeCatalog(value: unknown): CatalogEntry[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (typeof entry === "string") return [{ name: entry }];
      if (isRecord(entry) && typeof entry.name === "string") return [{ name: entry.name }];
      return [];
    }).sort((left, right) => left.name.localeCompare(right.name));
  }
  if (isRecord(value) && Array.isArray(value.specialists)) return normalizeCatalog(value.specialists);
  return [];
}

function getSpecialistsConfigPath(filename: string): { path: string; exists: boolean; source: ConsoleConfigSource } {
  const home = process.env.HOME?.trim() || homedir();
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) {
    const path = join(xdgConfigHome, SPECIALISTS_SUBDIR, filename);
    return { path, exists: existsSync(path), source: "xdg" };
  }
  const configHomePath = join(home, ".config", SPECIALISTS_SUBDIR, filename);
  if (existsSync(configHomePath)) return { path: configHomePath, exists: true, source: "config-home" };
  const legacyPath = join(home, ".specialists", filename);
  if (existsSync(legacyPath)) return { path: legacyPath, exists: true, source: "legacy" };
  return { path: configHomePath, exists: false, source: "config-home" };
}

function displayPath(path: string): string {
  const home = process.env.HOME?.trim() || homedir();
  return home && path.startsWith(home) ? path.replace(home, "~") : path;
}

async function safeJson<T>(request: Request): Promise<T | null> {
  try {
    return await request.json() as T;
  } catch {
    return null;
  }
}

function readJsonFile(path: string): { ok: true; value: unknown } | { ok: false; value: Record<string, never>; error?: string } {
  if (!existsSync(path)) return { ok: false, value: {} };
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { ok: false, value: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

function validateUserMutationBody(body: UserMutationBody): string | null {
  if (!body || typeof body !== "object") return "invalid body";
  if (typeof body.specialist !== "string" || body.specialist.trim().length === 0) return "specialist required";
  if (!LEAF_FIELDS.includes(body.path)) return "path not allowed";
  if (!["set", "append", "remove"].includes(body.op)) return "op not allowed";
  if (body.op !== "set" && body.value === undefined) return "value required";
  return null;
}

function applyUserMutation(raw: Record<string, unknown>, body: UserMutationBody): Record<string, unknown> {
  if (body.op === "set") return applyFieldEdit(raw, body.specialist, body.path, body.value ?? null);
  const currentSpecialist = isRecord(raw[body.specialist]) ? raw[body.specialist] as Record<string, unknown> : {};
  const existing = readLeaf(currentSpecialist, body.path);
  const next = Array.isArray(existing) ? [...existing] : [];
  const serialized = JSON.stringify(body.value);
  if (body.op === "append") {
    if (!next.some((item) => JSON.stringify(item) === serialized)) next.push(body.value);
  } else {
    const filtered = next.filter((item) => JSON.stringify(item) !== serialized);
    return applyFieldEdit(raw, body.specialist, body.path, filtered);
  }
  return applyFieldEdit(raw, body.specialist, body.path, next);
}

export function applyFieldEdit(raw: Record<string, unknown>, specialist: string, path: string, value: unknown): Record<string, unknown> {
  const clone = structuredClone(raw);
  const top = (isRecord(clone[specialist]) ? clone[specialist] : {}) as Record<string, unknown>;
  const parts = path.split(".");
  let cursor = top;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]!;
    const existing = cursor[key];
    if (isRecord(existing)) cursor = existing;
    else {
      const next: Record<string, unknown> = {};
      cursor[key] = next;
      cursor = next;
    }
  }
  cursor[parts[parts.length - 1]!] = value;
  clone[specialist] = top;
  return clone;
}

export function validateGlobalUserConfig(value: unknown): ValidationError[] {
  if (!isRecord(value)) return [{ path: "json", message: "Expected object" }];
  const errors: ValidationError[] = [];
  for (const [specialist, override] of Object.entries(value)) {
    if (specialist.startsWith("_")) continue;
    if (!isRecord(override)) {
      errors.push({ path: specialist, message: "Expected object" });
      continue;
    }
    for (const path of LEAF_FIELDS) {
      const leaf = readLeaf(override, path);
      if (leaf === undefined) continue;
      errors.push(...validateLeaf(`${specialist}.${path}`, path, leaf));
    }
    for (const key of Object.keys(override)) {
      if (!["execution", "prompt", "stall_detection", "beads_write_notes", "notes_mode", "output_file", "skills"].includes(key)) {
        errors.push({ path: `${specialist}.${key}`, message: "Unrecognized key" });
      }
    }
  }
  return errors;
}

function validateLeaf(fullPath: string, path: LeafPath, value: unknown): ValidationError[] {
  if (value === null) return [];
  switch (path) {
    case "execution.model":
    case "execution.fallback_model":
    case "output_file":
      return typeof value === "string" ? [] : [{ path: fullPath, message: "Expected string|null" }];
    case "execution.fallback_models":
    case "skills.paths":
      return isStringArray(value) ? [] : [{ path: fullPath, message: "Expected string[]|null" }];
    case "execution.timeout_ms":
    case "execution.stall_timeout_ms":
    case "stall_detection.waiting_auto_close_ms":
      return typeof value === "number" ? [] : [{ path: fullPath, message: "Expected number|null" }];
    case "execution.max_retries":
      return typeof value === "number" && Number.isInteger(value) && value >= 0 ? [] : [{ path: fullPath, message: "Expected int >= 0|null" }];
    case "execution.prompt_limit_bytes":
    case "execution.stdout_limit_bytes":
      return typeof value === "number" && Number.isInteger(value) && value > 0 ? [] : [{ path: fullPath, message: "Expected positive int|null" }];
    case "execution.interactive":
    case "execution.extensions.serena":
    case "execution.extensions.gitnexus":
    case "beads_write_notes":
      return typeof value === "boolean" ? [] : [{ path: fullPath, message: "Expected boolean|null" }];
    case "execution.thinking_level":
      return typeof value === "string" && THINKING_LEVELS.has(value) ? [] : [{ path: fullPath, message: "Expected valid thinking level|null" }];
    case "prompt.system_prompt_mode":
      return typeof value === "string" && SYSTEM_PROMPT_MODES.has(value) ? [] : [{ path: fullPath, message: "Expected append|replace|null" }];
    case "notes_mode":
      return typeof value === "string" && NOTES_MODES.has(value) ? [] : [{ path: fullPath, message: "Expected full-trail|final-only|null" }];
  }
}

export function writeGlobalConfigSafe(rawObj: Record<string, unknown> | ConsoleConfig, path: string, expectedMtimeMs?: number, validate: (value: unknown) => ValidationError[] = validateGlobalUserConfig): { ok: boolean; errors?: ValidationError[]; errorClass?: string } {
  if (typeof expectedMtimeMs === "number" && existsSync(path)) {
    try {
      const stat = statSync(path);
      if (Math.floor(stat.mtimeMs) !== Math.floor(expectedMtimeMs)) return { ok: false, errorClass: "mtime_mismatch" };
    } catch {
      return { ok: false, errorClass: "stat_failed" };
    }
  }
  const errors = validate(rawObj);
  if (errors.length > 0) return { ok: false, errors, errorClass: "schema_invalid" };
  try {
    mkdirSync(dirname(path), { recursive: true });
    const payload = `${JSON.stringify(rawObj, null, 2)}\n`;
    const tmpPath = `${path}.tmp.${process.pid}.${Math.floor(performance.now() * 1000)}`;
    try {
      writeFileSync(tmpPath, payload, "utf8");
      renameSync(tmpPath, path);
    } catch (renameError) {
      try { rmSync(tmpPath, { force: true }); } catch {}
      throw renameError;
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, errorClass: (error as NodeJS.ErrnoException | undefined)?.code ?? (error instanceof Error ? error.name : "unknown") };
  }
}

export function statConfigFileMtimeMs(path: string): number | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function runSpEdit(body: UserMutationBody, runCommand: RunCommand) {
  const command = process.env.GITBOARD_SP_BIN || "sp";
  const key = `${body.specialist}.${body.path}`;
  const value = stringifyCliValue(body.value);
  if (body.op === "append") return runCommand(command, ["edit", "--global", "--append", key, value]);
  if (body.op === "remove") return runCommand(command, ["edit", "--global", "--remove", key, value]);
  return runCommand(command, ["edit", "--global", "--set", key, value]);
}

function stringifyCliValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function readLeaf(obj: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = obj;
  for (const part of path.split(".")) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function readConsoleConfig(): ConsoleConfig | null {
  const location = getSpecialistsConfigPath(CONSOLE_CONFIG_FILENAME);
  if (!location.exists) return null;
  const parsed = readJsonFile(location.path);
  if (!parsed.ok || !isRecord(parsed.value)) return null;
  return normalizeConsoleConfig(parsed.value);
}

function normalizeConsoleConfig(raw: Record<string, unknown>): ConsoleConfig {
  return {
    _doc: typeof raw._doc === "string" ? raw._doc : CONSOLE_CONFIG_DOC,
    schema_version: typeof raw.schema_version === "number" ? raw.schema_version : CONSOLE_CONFIG_SCHEMA_VERSION,
    base_dirs: Array.isArray(raw.base_dirs) ? raw.base_dirs.filter((item): item is string => typeof item === "string") : [],
    repos: Array.isArray(raw.repos) ? raw.repos.flatMap((entry) => isRecord(entry) && typeof entry.name === "string" && typeof entry.path === "string" ? [{ name: entry.name, path: entry.path }] : []) : [],
    auto_discovered_at: typeof raw.auto_discovered_at === "string" ? raw.auto_discovered_at : undefined,
  };
}

function validateConsoleConfig(value: unknown): ValidationError[] {
  if (!isRecord(value)) return [{ path: "json", message: "Expected object" }];
  if (!Array.isArray(value.base_dirs) || !value.base_dirs.every((item) => typeof item === "string")) return [{ path: "base_dirs", message: "Expected string[]" }];
  if (!Array.isArray(value.repos)) return [{ path: "repos", message: "Expected repo array" }];
  const repoErrors = value.repos.flatMap((entry, index) => isRecord(entry) && typeof entry.name === "string" && typeof entry.path === "string" ? [] : [{ path: `repos.${index}`, message: "Expected {name,path}" }]);
  return repoErrors;
}

function buildConsoleConfigTemplate(repos: ConsoleRepoEntry[], baseDirs: string[], nowIso: string): ConsoleConfig {
  return { _doc: CONSOLE_CONFIG_DOC, schema_version: CONSOLE_CONFIG_SCHEMA_VERSION, base_dirs: baseDirs, repos, auto_discovered_at: nowIso };
}

function applyConsoleMutation(current: ConsoleConfig, body: ConsoleMutationBody, now: () => number): { ok: true; value: ConsoleConfig } | { ok: false; status: 400; error: string } {
  switch (body.action) {
    case "addRepo": {
      const nextRepo = body.repo;
      if (!nextRepo?.name || !nextRepo.path) return { ok: false, status: 400, error: "repo required" };
      const exists = current.repos.some((repo) => repo.name === nextRepo.name || normalizePath(repo.path) === normalizePath(nextRepo.path));
      if (exists) return { ok: false, status: 400, error: "repo already configured" };
      return { ok: true, value: { ...current, repos: sortRepos([...current.repos, nextRepo]) } };
    }
    case "removeRepo": {
      if (!body.previousName) return { ok: false, status: 400, error: "previousName required" };
      return { ok: true, value: { ...current, repos: current.repos.filter((repo) => repo.name !== body.previousName) } };
    }
    case "editRepo": {
      if (!body.previousName || !body.field || typeof body.value !== "string") return { ok: false, status: 400, error: "edit payload required" };
      const field = body.field;
      const value = body.value;
      const repos = current.repos.map((repo) => repo.name !== body.previousName ? repo : { ...repo, [field]: value });
      return { ok: true, value: { ...current, repos: sortRepos(repos) } };
    }
    case "addBaseDir": {
      if (!body.baseDir) return { ok: false, status: 400, error: "baseDir required" };
      if (current.base_dirs.includes(body.baseDir)) return { ok: true, value: current };
      return { ok: true, value: { ...current, base_dirs: [...current.base_dirs, body.baseDir] } };
    }
    case "removeBaseDir": {
      if (!body.baseDir) return { ok: false, status: 400, error: "baseDir required" };
      return { ok: true, value: { ...current, base_dirs: current.base_dirs.filter((entry) => entry !== body.baseDir) } };
    }
    case "rescan": {
      const discovery = discoverRepos(current.base_dirs.length > 0 ? current.base_dirs : DEFAULT_BASE_DIR_CANDIDATES);
      const byPath = new Map<string, ConsoleRepoEntry>();
      for (const repo of current.repos) byPath.set(normalizePath(repo.path), repo);
      for (const repo of discovery.repos) byPath.set(normalizePath(repo.path), repo);
      return { ok: true, value: { ...current, base_dirs: discovery.scannedBaseDirs, repos: sortRepos([...byPath.values()]), auto_discovered_at: new Date(now()).toISOString() } };
    }
  }
}

function sortRepos(repos: ConsoleRepoEntry[]): ConsoleRepoEntry[] {
  return [...repos].sort((left, right) => left.name.localeCompare(right.name));
}

function normalizePath(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function discoverRepos(baseDirCandidates: readonly string[]) {
  const seen = new Set<string>();
  const repos: ConsoleRepoEntry[] = [];
  const scannedBaseDirs: string[] = [];
  for (const candidate of baseDirCandidates) {
    const baseDir = expandHomePath(candidate);
    if (!safeIsDirectory(baseDir)) continue;
    scannedBaseDirs.push(candidate);
    walk(baseDir, 1, seen, repos);
  }
  return { repos: sortRepos(repos), scannedBaseDirs };
}

function walk(dir: string, depth: number, seen: Set<string>, repos: ConsoleRepoEntry[]): void {
  if (isWorktreeDir(dir)) return;
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const root = join(dir, entry);
    if (!safeIsDirectory(root) || isWorktreeDir(root)) continue;
    if (looksLikeSpecialistsRepo(root)) {
      if (!seen.has(root)) {
        seen.add(root);
        repos.push({ name: basename(root), path: root });
      }
      continue;
    }
    if (depth < MAX_SCAN_DEPTH) walk(root, depth + 1, seen, repos);
  }
}

function expandHomePath(path: string): string {
  const home = process.env.HOME?.trim() || homedir();
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function safeIsDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function isWorktreeDir(path: string): boolean {
  try {
    const gitPath = join(path, ".git");
    if (!existsSync(gitPath)) return false;
    return !statSync(gitPath).isDirectory();
  } catch {
    return false;
  }
}

function looksLikeSpecialistsRepo(root: string): boolean {
  return existsSync(join(root, ".specialists/db/observability.db")) || existsSync(join(root, ".specialists/jobs"));
}
