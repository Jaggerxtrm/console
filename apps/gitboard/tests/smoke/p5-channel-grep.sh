#!/usr/bin/env bash
# P5 channel-rename smoke (forge-eorh.13): no stale beads:* WS channel/event refs in production source.
# Counts only actual code refs (subscribe/publish/channel literals), not comments or docs.

set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Look for stale channel/event names in src/ (production paths) — comments stripped.
matches="$(git -C "${ROOT_DIR}" grep -nE '"beads:(changes|sync_hint|project)' -- 'src/*' \
  | grep -vE '^\s*//|^\s*\*|/\*|\*/|^[^:]+:[0-9]+:\s*//' || true)"

if [[ -n "${matches}" ]]; then
  echo "stale beads:* refs in production code:" >&2
  echo "${matches}" >&2
  exit 1
fi

echo "p5-channel-grep: ok"
