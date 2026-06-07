# xtrm — Claude Code Guide

## Project summary

Bun monorepo for the **xtrm** agent orchestration + GitHub-activity stack.

- `apps/gitboard` (`@xtrm/gitboard`) — primary backend / materializer; serves the dashboard built with Vite.
- `apps/console` — `console` frontend (served at `/console`).
- `packages/{core, api-client, html-preview, ui}` — shared TypeScript libs.

Runtime: Bun + TypeScript; tests via Vitest. Deploys as a `gitboard.service` systemd user unit bound to the host's Tailscale IP.

## Project map

- `apps/gitboard/src/` — API routes, materializer, core domain logic
- `apps/console/` — frontend UI
- `packages/core/` — shared materializer / domain primitives
- `packages/api-client/` — typed client for `/api/*`
- `.xtrm/` — agent workflow config (instructions, hooks, MCP, settings)
- `XTRM-GUIDE.md` — full xtrm workflow reference

## Essential build / test

- `bun install` — install workspace deps
- `bun run build` (= `build:packages && build:apps`) — full build
- `bun run --filter @xtrm/gitboard test` — gitboard tests (Vitest)
- `bun run --filter @xtrm/gitboard lint` — gitboard typecheck (`tsc --noEmit`)

---

<!-- xtrm:start -->
# XTRM Agent Workflow

> Full reference: [XTRM-GUIDE.md](XTRM-GUIDE.md) | Session manual: `/using-xtrm` skill
> Run `bd prime` at session start (or after `/compact`) for live beads workflow context.
> For command syntax, prefer `--help` (e.g. `bd --help`, `bv --help`, `xt --help`, `sp --help`) over copied tables.

## Session Start

1. `bd prime` — load workflow context and active claims
2. `bv --robot-triage` — ranked picks (or `bd ready` for raw queue)
3. `bd update <id> --claim` — claim before any file edit

## Execution Interaction Policy

- Proceed by default on standard implementation tasks once scope is clear.
- Do **not** ask repetitive "Proceed?" confirmations.
- Ask for confirmation only when actions are destructive, irreversible, or high-risk (e.g. `rm`, history rewrite, mass deletes, credential rotation, prod-impacting ops).
- Prefer concise clarifying questions only when requirements are genuinely ambiguous.

## Active Gates (hooks enforce these — not optional)

| Gate | Trigger | Required action |
|------|---------|-----------------|
| **Edit** | Write/Edit without active claim | `bd update <id> --claim` |
| **Commit** | `git commit` while claim is open | `bd close <id>` first, then commit |
| **Stop** | Session end with unclosed claim | `bd close <id>` |
| **Memory** | `bd close <id>` without issue ack | `bd remember "<insight>"` (or decide nothing novel), then `bd kv set "memory-acked:<id>" "saved:<key>"` (or `"nothing novel:<reason>"`), then retry `bd close <id> --reason="..."` |

## Essential commands

Tiny surface — for full syntax use `--help`.

- **Work**: `bd ready`, `bd list --status=in_progress`, `bd show <id>`, `bd update <id> --claim`, `bd close <id> --reason="…"`
- **Triage**: `bv --robot-triage` (use only `--robot-*` flags — bare `bv` opens a TUI that blocks the session)
- **Memory**: `bd remember "<insight>"`, `bd memories <kw>`, `bd recall <key>`
- **Specialists**: `sp list`, `sp ps`, `sp feed <job>`, `sp result <job>` — load `/using-specialists-v3` (or latest `/using-specialists-*`) for orchestration
- **Worktrees**: `xt claude` (new session), `xt end` (commit / push / PR / cleanup)

## Git Workflow

Strict: one branch per issue.

```bash
git checkout -b feature/<issue-id>-<slug>
bd update <id> --claim
# ... edit ...
bd close <id> --reason="..."
xt end
```

Never continue new work on a previously-shipped branch.

## Code Intelligence (mandatory before edits)

- **Serena** (`/using-serena-lsp`): symbol-aware reads and edits. Never grep-read-sed when symbolic tools are available.
- **GitNexus** MCP — required before touching any symbol:
  - `gitnexus_impact({target, direction: "upstream"})` — blast radius
  - `gitnexus_detect_changes()` — verify scope before commit
  - Stop and warn the user on HIGH/CRITICAL risk.
  - For deeper workflows: `/gitnexus-impact-analysis`, `/gitnexus-debugging`, `/gitnexus-refactoring`.

## Quality Gates (automatic on every edit, via PostToolUse hooks)

- TS/JS: ESLint + tsc
- Python: ruff + mypy

Fix failures before committing.

## Skill routing

| Need | Load |
|------|------|
| xtrm workflow / gates | `/using-xtrm` |
| Specialist orchestration | `/using-specialists-v3` (or latest available) |
| GitNexus impact / debug / refactor | `/gitnexus-impact-analysis`, `/gitnexus-debugging`, `/gitnexus-refactoring` |
| Service-scoped tasks | `/scope`, `/using-service-skills` |
| Release / session close | `/releasing`, `/xt-end`, `/session-close-report` |
<!-- xtrm:end -->

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **gitboard** (9812 symbols, 19000 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/gitboard/context` | Codebase overview, check index freshness |
| `gitnexus://repo/gitboard/clusters` | All functional areas |
| `gitnexus://repo/gitboard/processes` | All execution flows |
| `gitnexus://repo/gitboard/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
