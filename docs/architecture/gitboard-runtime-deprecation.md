# Retired Gitboard runtime

Status: historical completion record.

The deprecated `apps/gitboard` package and `@xtrm/gitboard` workspace were
removed after production moved to `console.service`. All HTTP adapters,
realtime upgrades, terminal boundaries, scanners, watchers, materializer,
GitHub polling, static serving, and shutdown hooks now compose under
`apps/console`; reusable implementations remain in `packages/core`.

The old `gitboard.service` unit was retained host-locally only through the two
required observation windows, then removed with its drop-ins and rollback
worktree. It is not a supported service or repository artifact.

Intentional compatibility that remains:

- `/gitboard`, `/gitboard/*`, and old asset paths permanently redirect to
  `/console` with HTTP `308`.
- `GITBOARD_DATA_DIR` and selected legacy environment names remain accepted as
  fallback aliases so existing state/config is honored in place.
- historical reports, changelog entries, migration specs, guard sentinels, and
  dependency dossiers retain old names as evidence.

Bridge-table and daemon read-model retirement were explicitly out of scope for
the host retirement and remain independent future work.
