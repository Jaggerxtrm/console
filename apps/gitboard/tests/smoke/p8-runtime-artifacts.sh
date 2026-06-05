#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

tracked_runtime_artifacts="$(
  git ls-files apps/gitboard |
    awk '
      /^apps\/gitboard\/data\// { print; next }
      /^apps\/gitboard\/logs\// { print; next }
      /^apps\/gitboard\/\.tmp-logs\// { print; next }
      /\.(sqlite|db)$/ && $0 !~ /^apps\/gitboard\/tests\// { print; next }
    '
)"

if [[ -n "$tracked_runtime_artifacts" ]]; then
  printf 'tracked runtime artifacts found:\n%s\n' "$tracked_runtime_artifacts" >&2
  exit 1
fi

fixture_dbs="$(git ls-files 'apps/gitboard/tests/**/*.db')"
if [[ -z "$fixture_dbs" ]]; then
  printf 'expected observability fixture DBs to remain tracked\n' >&2
  exit 1
fi

printf 'p8-runtime-artifacts: ok\n'
