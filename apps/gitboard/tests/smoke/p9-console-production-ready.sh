#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_ROOT="$(cd "${ROOT_DIR}/../.." && pwd)"
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

if [[ ! -f "${REPO_ROOT}/apps/console/dist/dashboard/console/index.html" ]]; then
  echo "missing Console build; run: bun run --cwd apps/console build" >&2
  exit 1
fi

if [[ ! -f "${REPO_ROOT}/apps/gitboard/dist/dashboard/gitboard/index.html" ]]; then
  echo "missing compatibility shell build; run: bun run --cwd apps/gitboard build:dashboard" >&2
  exit 1
fi

NODE_ENV=production PORT=3100 GITBOARD_DATA_DIR="${TMP_DIR}/data" SKIP_GITHUB_POLLER=1 bun --cwd "${ROOT_DIR}" src/index.ts >/dev/null 2>&1 &
APP_PID="$!"

for _ in {1..100}; do
  if curl -fsS "http://localhost:3100/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

check_status() {
  local path="$1"
  local expected="$2"
  local status
  status="$(curl -o /dev/null -s -w "%{http_code}" "http://localhost:3100${path}")"
  if [[ "${status}" != "${expected}" ]]; then
    echo "expected ${expected} for ${path}, got ${status}" >&2
    exit 1
  fi
}

check_status "/console" "200"
check_status "/console/operations" "200"
check_status "/gitboard" "200"
check_status "/beadboard" "404"

root_location="$(curl -o /dev/null -s -w "%{redirect_url}" "http://localhost:3100/")"
if [[ "${root_location}" != "http://localhost:3100/console" ]]; then
  echo "expected root redirect to /console, got ${root_location}" >&2
  exit 1
fi

echo "p9-console-production-ready: ok"
