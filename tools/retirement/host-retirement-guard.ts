#!/usr/bin/env bun
/**
 * Console host-retirement guard (Phase 0 hard gate).
 *
 * Scans the repository for production references to the deprecated
 * `apps/gitboard` host across the surfaces named in
 * `docs/console-host-retirement-spec.md`:
 *
 *   - service definitions (systemd `ExecStart*=` lines)
 *   - container build/run files (Dockerfile / compose)
 *   - build & dev scripts (justfile / Makefile / shell)
 *   - workspace manifests (package.json `scripts`)
 *   - the production import graph (apps|packages `src` modules)
 *
 * Docs prose, history, test fixtures, and migration *descriptor metadata*
 * (e.g. `packages/core/src/runtime/ownership.ts` string labels) are NOT
 * gate violations: the import scanner only matches real module-import
 * syntax, never bare string literals.
 *
 * Modes:
 *   - strict             fail on ANY production reference (red until cutover)
 *   - console-host       scan the intended end-state fixture (must pass)
 *   - no-new-regressions baseline-aware; fail only on references absent from
 *                        the committed baseline (passes until final deletion)
 *
 * CLI:
 *   bun run tools/retirement/host-retirement-guard.ts --mode strict
 *   bun run tools/retirement/host-retirement-guard.ts --mode no-new-regressions
 *   bun run tools/retirement/host-retirement-guard.ts --mode console-host
 *   bun run tools/retirement/host-retirement-guard.ts --mode strict --json
 *   bun run tools/retirement/host-retirement-guard.ts --update-baseline
 */
import { readdirSync, readFileSync, lstatSync, openSync, fstatSync, readSync, closeSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const DEPRECATED_HOST_PATH = "apps/gitboard";
export const DEPRECATED_HOST_PACKAGE = "@xtrm/gitboard";

/**
 * Conservative per-file ceiling for guard candidate reads, enforced before
 * allocation. Far above every real classified source/manifest file (largest
 * current source is ~50 KiB). A candidate larger than this fails closed with a
 * structured finding instead of being read unbounded.
 */
export const GUARD_MAX_FILE_BYTES = 1024 * 1024;

export type GuardCategory =
  | "service-definition"
  | "container"
  | "build-script"
  | "workspace-manifest"
  | "production-import"
  | "unsafe-fs-entry";

export type GuardMode = "strict" | "console-host" | "no-new-regressions";

export interface GuardFinding {
  readonly category: GuardCategory;
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
  readonly fingerprint: string;
}

export interface GuardReport {
  readonly mode: GuardMode;
  readonly root: string;
  readonly pass: boolean;
  readonly verdict: "PASS" | "FAIL";
  readonly reason: string;
  readonly findings: readonly GuardFinding[];
  readonly newRegressions: readonly GuardFinding[];
  readonly resolved: readonly string[];
  readonly scannedFiles: number;
}

export interface GuardOptions {
  readonly mode: GuardMode;
  readonly root: string;
  readonly baselinePath?: string;
  readonly fixtureRoot?: string;
}

const FIXTURE_RELATIVE_DIR = join("tools", "retirement", "fixtures");

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".worktrees",
  "dist",
  "build",
  "coverage",
  ".next",
  ".xtrm",
  ".beads",
  ".pi",
  ".serena",
  ".codex",
  ".zed",
  "design-mocks",
]);

const IGNORED_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp",
  ".woff", ".woff2", ".ttf", ".eot",
  ".pdf", ".zip", ".tar", ".gz",
  ".lock", ".sqlite", ".db", ".map",
]);

const SERVICE_DEFINITION_EXTENSIONS = new Set([".service", ".md", ".ini", ".conf"]);
const CONTAINER_FILE_NAMES = new Set([
  "dockerfile", "containerfile", "compose.yml", "compose.yaml",
]);
const BUILD_SCRIPT_NAMES = new Set(["justfile", "makefile"]);
const BUILD_SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".mk"]);

// Test/fixture references to the deprecated host are explicitly allowed by the
// spec ("docs/history/test-fixture only"); they are not production host paths.
const TEST_DIR_NAMES = new Set(["test", "tests", "__tests__", "fixtures", "mocks", "e2e"]);
const TEST_FILE_RE = /\.(spec|test|fixture)\./;

const PATH_MARKER = DEPRECATED_HOST_PATH;
const EXEC_START_RE = /^\s*ExecStart\w*\s*=/;
const IMPORT_SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

function normalizeSnippet(snippet: string): string {
  return snippet.trim().replace(/\s+/g, " ");
}

function fingerprint(category: GuardCategory, file: string, snippet: string): string {
  return `${category}::${file}::${normalizeSnippet(snippet)}`;
}

function makeFinding(category: GuardCategory, file: string, line: number, snippet: string): GuardFinding {
  return { category, file, line, snippet: snippet.trim(), fingerprint: fingerprint(category, file, snippet) };
}

function isGitboardImportSpecifier(specifier: string): boolean {
  return (
    specifier === DEPRECATED_HOST_PACKAGE ||
    specifier.startsWith(`${DEPRECATED_HOST_PACKAGE}/`) ||
    specifier.includes(DEPRECATED_HOST_PATH)
  );
}

function scanServiceDefinition(file: string, content: string): GuardFinding[] {
  const findings: GuardFinding[] = [];
  content.split("\n").forEach((rawLine, index) => {
    if (!EXEC_START_RE.test(rawLine)) return;
    if (!rawLine.includes(PATH_MARKER)) return;
    findings.push(makeFinding("service-definition", file, index + 1, rawLine));
  });
  return findings;
}

function scanContainerFile(file: string, content: string): GuardFinding[] {
  const findings: GuardFinding[] = [];
  content.split("\n").forEach((rawLine, index) => {
    if (!rawLine.includes(PATH_MARKER)) return;
    findings.push(makeFinding("container", file, index + 1, rawLine));
  });
  return findings;
}

function scanBuildScript(file: string, content: string): GuardFinding[] {
  const findings: GuardFinding[] = [];
  content.split("\n").forEach((rawLine, index) => {
    if (!rawLine.includes(PATH_MARKER)) return;
    findings.push(makeFinding("build-script", file, index + 1, rawLine));
  });
  return findings;
}

function scanWorkspaceManifest(file: string, content: string): GuardFinding[] {
  let manifest: { scripts?: Record<string, string> };
  try {
    manifest = JSON.parse(content) as { scripts?: Record<string, string> };
  } catch {
    return [];
  }
  const scripts = manifest.scripts ?? {};
  const findings: GuardFinding[] = [];
  const lines = content.split("\n");
  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value !== "string" || !value.includes(PATH_MARKER)) continue;
    const lineNumber = lines.findIndex((l) => l.includes(`"${name}"`)) + 1;
    findings.push(makeFinding("workspace-manifest", file, lineNumber || 1, `"${name}": "${value}"`));
  }
  return findings;
}

function scanProductionImports(file: string, content: string): GuardFinding[] {
  const findings: GuardFinding[] = [];
  content.split("\n").forEach((rawLine, index) => {
    IMPORT_SPEC_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_SPEC_RE.exec(rawLine)) !== null) {
      if (isGitboardImportSpecifier(match[1])) {
        findings.push(makeFinding("production-import", file, index + 1, rawLine));
        break;
      }
    }
  });
  return findings;
}

function classifyFile(relPath: string): ((file: string, content: string) => GuardFinding[]) | null {
  const base = relPath.split(sep).pop()?.toLowerCase() ?? "";
  const ext = base.includes(".") ? `.${base.split(".").pop()}` : "";

  if (base === "package.json") return scanWorkspaceManifest;
  if (CONTAINER_FILE_NAMES.has(base) || base.startsWith("dockerfile.") || base.startsWith("compose.")) {
    return scanContainerFile;
  }
  if (BUILD_SCRIPT_NAMES.has(base) || BUILD_SCRIPT_EXTENSIONS.has(ext)) return scanBuildScript;
  if (SERVICE_DEFINITION_EXTENSIONS.has(ext)) return scanServiceDefinition;

  if (isProductionSourcePath(relPath)) return scanProductionImports;
  return null;
}

function isProductionSourcePath(relPath: string): boolean {
  const parts = relPath.split(sep);
  if (parts.length < 3) return false;
  const [top, , third] = parts;
  if ((top !== "apps" && top !== "packages") || third !== "src") return false;
  return /\.(ts|tsx|js|jsx|cjs|mjs)$/.test(relPath);
}

function shouldIgnoreDir(name: string, relPath: string): boolean {
  if (IGNORED_DIRS.has(name)) return true;
  if (TEST_DIR_NAMES.has(name)) return true;
  if (relPath === FIXTURE_RELATIVE_DIR || relPath.startsWith(`${FIXTURE_RELATIVE_DIR}${sep}`)) return true;
  return false;
}

function isTestFile(name: string): boolean {
  return TEST_FILE_RE.test(name);
}

function walkFiles(root: string): { files: string[]; findings: GuardFinding[] } {
  const collected: string[] = [];
  const findings: GuardFinding[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      // Fail closed: an unreadable directory prevents complete classification,
      // so it is an exact-path unsafe finding rather than a silent skip.
      findings.push(
        makeFinding("unsafe-fs-entry", relative(root, dir) || ".", 1, "unreadable directory; guard cannot list entries for classification"),
      );
      return;
    }
    for (const entry of entries) {
      const absolute = join(dir, entry);
      const relPath = relative(root, absolute);
      let stats;
      try {
        // lstat (not stat): never follow symlinks, so symlinked directories and
        // cycles are not recursed and symlinked files are not read.
        stats = lstatSync(absolute);
      } catch {
        // Fail closed: an unstatable entry (unreadable, or deleted mid-scan)
        // cannot be classified. Name-ignored entries stay ignored; everything
        // else is an exact-path unsafe finding rather than a silent skip.
        if (shouldIgnoreDir(entry, relPath)) continue;
        findings.push(makeFinding("unsafe-fs-entry", relPath, 1, "unstatable fs entry; guard cannot classify path"));
        continue;
      }
      if (stats.isSymbolicLink()) {
        // Fail closed: any non-ignored symlink is a structured finding. The
        // guard refuses to classify through a link it will not follow.
        if (shouldIgnoreDir(entry, relPath)) continue;
        findings.push(makeFinding("unsafe-fs-entry", relPath, 1, "symlinked path; guard does not follow symlinks"));
        continue;
      }
      if (stats.isDirectory()) {
        if (shouldIgnoreDir(entry, relPath)) continue;
        walk(absolute);
        continue;
      }
      if (!stats.isFile()) continue;
      const ext = entry.includes(".") ? `.${entry.split(".").pop()}` : "";
      if (IGNORED_EXTENSIONS.has(ext)) continue;
      if (isTestFile(entry)) continue;
      collected.push(relPath);
    }
  };
  walk(root);
  return { files: collected.sort(), findings };
}

/**
 * Reads a classified candidate with a hard size cap enforced before
 * allocation. Returns the content when within the ceiling, "oversized" when
 * the file exceeds it (caller fails closed), or null when unreadable. At most
 * the validated size is read, so a concurrently growing file cannot force an
 * unbounded allocation.
 */
function readCandidateBounded(absolutePath: string): string | "oversized" | null {
  let fd: number | undefined;
  try {
    fd = openSync(absolutePath, "r");
    const info = fstatSync(fd);
    if (!info.isFile()) return null;
    if (info.size > GUARD_MAX_FILE_BYTES) return "oversized";
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const bytesRead = readSync(fd, buffer, offset, buffer.byteLength - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.toString("utf8", 0, offset);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

export function scanTree(root: string): { findings: GuardFinding[]; scannedFiles: number } {
  const { files, findings } = walkFiles(root);
  for (const relPath of files) {
    const scanner = classifyFile(relPath);
    if (!scanner) continue;
    const content = readCandidateBounded(join(root, relPath));
    if (content === null) {
      // Fail closed: open/fstat/read/decode failure on a classified candidate
      // prevents complete classification, so it is an exact-path unsafe finding
      // rather than a silent skip.
      findings.push(makeFinding("unsafe-fs-entry", relPath, 1, "unreadable candidate; guard cannot read classified file"));
      continue;
    }
    if (content === "oversized") {
      findings.push(
        makeFinding(
          "unsafe-fs-entry",
          relPath,
          1,
          `candidate exceeds guard cap of ${GUARD_MAX_FILE_BYTES} bytes; refusing unbounded read`,
        ),
      );
      continue;
    }
    findings.push(...scanner(relPath, content));
  }
  const seen = new Set<string>();
  const deduped = findings.filter((finding) => {
    if (seen.has(finding.fingerprint)) return false;
    seen.add(finding.fingerprint);
    return true;
  });
  return { findings: deduped, scannedFiles: files.length };
}

export function loadBaseline(baselinePath: string): Set<string> {
  if (!existsSync(baselinePath)) return new Set();
  const parsed = JSON.parse(readFileSync(baselinePath, "utf8")) as { fingerprints?: string[] };
  return new Set(parsed.fingerprints ?? []);
}

export function evaluate(options: GuardOptions): GuardReport {
  const root = options.mode === "console-host"
    ? options.fixtureRoot ?? join(options.root, FIXTURE_RELATIVE_DIR, "console-host")
    : options.root;

  const { findings, scannedFiles } = scanTree(root);

  if (options.mode === "strict" || options.mode === "console-host") {
    const pass = findings.length === 0;
    return {
      mode: options.mode,
      root,
      pass,
      verdict: pass ? "PASS" : "FAIL",
      reason: pass
        ? `No production references to ${DEPRECATED_HOST_PATH} (${scannedFiles} files scanned).`
        : `${findings.length} production reference(s) to ${DEPRECATED_HOST_PATH} remain.`,
      findings,
      newRegressions: findings,
      resolved: [],
      scannedFiles,
    };
  }

  const baselinePath = options.baselinePath ?? join(options.root, "tools", "retirement", "baseline.json");
  const baseline = loadBaseline(baselinePath);
  const currentFingerprints = new Set(findings.map((f) => f.fingerprint));
  const newRegressions = findings.filter((f) => !baseline.has(f.fingerprint));
  const resolved = [...baseline].filter((fp) => !currentFingerprints.has(fp)).sort();
  const pass = newRegressions.length === 0;

  return {
    mode: "no-new-regressions",
    root,
    pass,
    verdict: pass ? "PASS" : "FAIL",
    reason: pass
      ? `No new production references beyond baseline (${findings.length} known, ${resolved.length} resolved).`
      : `${newRegressions.length} new production reference(s) to ${DEPRECATED_HOST_PATH} beyond baseline.`,
    findings,
    newRegressions,
    resolved,
    scannedFiles,
  };
}

export function updateBaseline(root: string, baselinePath: string): number {
  const { findings } = scanTree(root);
  const fingerprints = [...new Set(findings.map((f) => f.fingerprint))].sort();
  const payload = {
    deprecatedHost: DEPRECATED_HOST_PATH,
    generatedAt: new Date().toISOString(),
    note: "Known production references to the deprecated host. Regenerate (shrinks over phases) with --update-baseline.",
    fingerprints,
  };
  writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return fingerprints.length;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function printReport(report: GuardReport, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`host-retirement-guard [${report.mode}] :: ${report.verdict}`);
  console.log(`root: ${report.root}`);
  console.log(`reason: ${report.reason}`);
  const listed = report.mode === "no-new-regressions" ? report.newRegressions : report.findings;
  for (const finding of listed) {
    console.log(`  ${finding.category}  ${finding.file}:${finding.line}  ${finding.snippet}`);
  }
  if (report.mode === "no-new-regressions" && report.resolved.length > 0) {
    console.log(`resolved since baseline: ${report.resolved.length}`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const mode = (args.mode as GuardMode) || "strict";
  const root = (args.root as string) || process.cwd();

  if (args["update-baseline"]) {
    const baselinePath = (args.baseline as string) || join(root, "tools", "retirement", "baseline.json");
    const count = updateBaseline(root, baselinePath);
    console.log(`baseline updated: ${count} fingerprint(s) -> ${baselinePath}`);
    return;
  }

  const report = evaluate({
    mode,
    root,
    baselinePath: args.baseline as string | undefined,
    fixtureRoot: args.fixture as string | undefined,
  });
  printReport(report, Boolean(args.json));
  process.exit(report.pass ? 0 : 1);
}

if (import.meta.main) {
  main();
}
