# Gitboard retirement reference classification

This table defines the allowed residual uses of the retired names after the
package deletion.

| Reference class | Allowed locations | Reason |
|---|---|---|
| Historical evidence | `CHANGELOG.md`, `.xtrm/reports/**`, dependency dossiers, completed specs/preflights, operations incident notes | Immutable record of prior code and service ownership |
| Guard sentinels | `tools/retirement/**`, deployment contract tests | Negative fixtures must contain the forbidden path/package literals to prove the guard fails closed |
| URL compatibility | Console redirect routes/tests and user-facing migration docs | `/gitboard*` intentionally returns `308` to `/console` |
| Environment compatibility | Console configuration/runtime tests and deployment docs | Legacy variable names select the same state/config as `XTRM_*`; no legacy implementation is loaded |
| Local state/config continuity | Compose physical volume name, legacy fold database name, and legacy config lookup | Keeps existing installations readable while Console owns the runtime |
| Telemetry compatibility | Existing dashboard fixture labels and LogQL selectors | Preserves Grafana/alert continuity until a separate observability migration updates both producers and consumers |
| Host-local rollback evidence | deploy-monitor artifacts and the completed retirement record | Documents the two controlled observation windows; not a runnable repo path |

Disallowed everywhere: production imports, workspace manifests, build scripts,
Docker commands, service `ExecStart`, runtime code paths, or test dependencies
on the retired package.
