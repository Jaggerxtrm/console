import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "../..");

function sourceFiles(root: string): string[] {
  const entries = readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return sourceFiles(path);
    return stat.isFile() && [".ts", ".tsx"].includes(extname(path)) ? [path] : [];
  });
  return entries.sort();
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function rel(path: string): string {
  return relative(appRoot, path);
}

describe("Console app/materializer/API separation boundary", () => {
  it("keeps dashboard code on public API DTOs instead of direct source or database reads", () => {
    const forbidden = [
      /\bfrom\s+["']bun:sqlite["']/,
      /\bimport\s+.*\bDatabase\b.*["']bun:sqlite["']/,
      /\bnew\s+Database\s*\(/,
      /\.beads\//,
      /\.agent-forge\//,
      /observability\.db/,
      /core\/materializer/,
      /core\/github-(poller|store|discover)/,
    ];

    const offenders = sourceFiles(join(appRoot, "src/dashboard")).flatMap((file) => {
      const text = read(file);
      return forbidden.some((pattern) => pattern.test(text)) ? [rel(file)] : [];
    });

    expect(offenders).toEqual([]);
  });

  it("keeps route handlers from owning bridge writes or materializer adapters", () => {
    const bridgeWrite = /\b(INSERT|UPDATE|DELETE)\b[\s\S]{0,160}\b(substrate_|specialist_|xtrm_forensic_events|xtrm_evidence_refs|materialization_state)\b/i;
    const materializerImport = /core\/materializer\/(beads-adapter|observability-adapter|index|types|snapshot-diff|queue)/;

    const offenders = sourceFiles(join(appRoot, "src/server/routes")).flatMap((file) => {
      const text = read(file);
      return bridgeWrite.test(text) || materializerImport.test(text) ? [rel(file)] : [];
    });

    expect(offenders).toEqual([]);
  });
});
