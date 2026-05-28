#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${HOME}/.xtrm/logs"
LEGACY_DIR="${HOME}/.agent-forge/logs"
TODAY_LOG="${LOG_DIR}/$(date +%F).jsonl"
LEGACY_LINK="${LOG_DIR}/legacy"
TMP_DIR="$(mktemp -d)"
APP_PID=""

cleanup() {
  if [[ -n "${APP_PID}" ]] && kill -0 "${APP_PID}" 2>/dev/null; then
    kill "${APP_PID}" 2>/dev/null || true
    wait "${APP_PID}" 2>/dev/null || true
  fi
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

LOG_DIR="${LOG_DIR}" GITBOARD_DATA_DIR="${TMP_DIR}/data" SKIP_GITHUB_POLLER=1 bun run --cwd "${ROOT_DIR}" src/index.ts >/dev/null 2>&1 &
APP_PID="$!"

for _ in {1..80}; do
  [[ -f "${TODAY_LOG}" ]] && break
  sleep 0.1
done

if [[ ! -f "${TODAY_LOG}" ]]; then
  echo "missing log file: ${TODAY_LOG}" >&2
  exit 1
fi

if ! grep -F '"component":"logger"' "${TODAY_LOG}" | grep -F '"event":"log.path"' | grep -F '"path":"/home/dawid/.xtrm/logs"' >/dev/null; then
  echo "missing logger log.path entry for ${TODAY_LOG}" >&2
  exit 1
fi

if [[ -e "${LEGACY_DIR}" ]]; then
  if [[ ! -L "${LEGACY_LINK}" ]]; then
    echo "missing legacy symlink: ${LEGACY_LINK}" >&2
    exit 1
  fi
  if [[ "$(readlink -f "${LEGACY_LINK}")" != "${LEGACY_DIR}" ]]; then
    echo "legacy symlink points wrong target" >&2
    exit 1
  fi
fi

echo "p7-logs-move: ok"
