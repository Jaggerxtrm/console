#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATA_DIR="${GITBOARD_DATA_DIR:-${HOME}/.agent-forge}"
SOURCE_PATH="${DATA_DIR}/gitboard.sqlite"
TARGET_PATH="${DATA_DIR}/xtrm.sqlite"
FIXTURE_PATH=""
TMP_DIR=""

cleanup() {
  if [[ -n "${TMP_DIR}" && -d "${TMP_DIR}" ]]; then
    rm -rf "${TMP_DIR}"
  fi
}
trap cleanup EXIT

if [[ -f "${SOURCE_PATH}" ]]; then
  FIXTURE_PATH="${SOURCE_PATH}"
else
  FIXTURE_PATH="$(ls -1t "${DATA_DIR}"/gitboard.sqlite.migrated.* 2>/dev/null | head -n 1 || true)"
  if [[ -z "${FIXTURE_PATH}" ]]; then
    echo "missing source fixture: ${SOURCE_PATH} or gitboard.sqlite.migrated.*" >&2
    exit 1
  fi
fi

TMP_DIR="$(mktemp -d)"
cp "${FIXTURE_PATH}" "${TMP_DIR}/gitboard.sqlite"

TMP_DIR="${TMP_DIR}" bun --cwd "${ROOT_DIR}" --eval '
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createXtrmDatabase } from "./src/core/xtrm-store.ts";
import { foldGitboardSQLite } from "./src/core/migrations/fold-gitboard-sqlite.ts";

const dataDir = process.env.TMP_DIR;
if (!dataDir) throw new Error("missing TMP_DIR");
const sourcePath = join(dataDir, "gitboard.sqlite");
const targetPath = join(dataDir, "xtrm.sqlite");
const tables = ["github_events", "github_commits", "github_repos", "github_prs", "github_issues", "github_releases", "github_repo_poll_state"] as const;

function countRows(db: Database): Record<string, number> {
  return Object.fromEntries(tables.map((table) => [table, db.query(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c ?? 0]));
}

const targetDb = createXtrmDatabase(targetPath);
const sourceDb = new Database(sourcePath, { readonly: true });
const beforeSource = countRows(sourceDb);
const beforeTarget = countRows(targetDb);
console.log(JSON.stringify({ phase: "before", beforeSource, beforeTarget }));
sourceDb.close();
targetDb.close();

const firstTarget = createXtrmDatabase(targetPath);
foldGitboardSQLite(sourcePath, firstTarget);
const afterTarget = countRows(firstTarget);
const migrated = readdirSync(dataDir).find((name) => name.startsWith("gitboard.sqlite.migrated."));
if (!migrated) throw new Error("missing migrated source");
if (existsSync(sourcePath)) throw new Error("active source still present after fold");
console.log(JSON.stringify({ phase: "after-first", afterTarget, migrated }));
firstTarget.close();

const secondTarget = createXtrmDatabase(targetPath);
foldGitboardSQLite(sourcePath, secondTarget);
const secondTargetCounts = countRows(secondTarget);
if (JSON.stringify(afterTarget) !== JSON.stringify(secondTargetCounts)) throw new Error("second boot changed counts");
if (!existsSync(join(dataDir, migrated))) throw new Error("migrated source missing after second boot");
console.log(JSON.stringify({ phase: "after-second", secondTargetCounts }));
secondTarget.close();
'
echo "p7-fold-db: ok"
