# xtrm Console Visual Contract

This document is the source of truth for the Gitboard/Beadboard unification style. Do not implement new console UI until it conforms to this contract.

## Product direction

The product is **xtrm console**: one professional operations console with multiple modules, not separate apps embedded into each other.

Primary modules:

- Git: pull requests, issues, GitHub activity, review conversations.
- Beads: beads issues, epics, dependencies, notes, execution state.

The operator should feel they are switching tabs in one app.

## Visual identity

Style name: **xtrm Console Minimal FUI**.

Influences:

- professional operations tooling
- GitHub list ergonomics
- Bloomberg/terminal density
- subtle institutional FUI discipline

Avoid:

- cyberpunk
- gamer RGB
- neon glows
- sci-fi decoration for its own sake
- bubbly/rounded cards
- duplicate app chrome

The look should be elegant, quiet, square, dense, and readable.

## Non-negotiable rules

1. **Gitboard = Beadboard.**
   - Same shell.
   - Same background.
   - Same row anatomy.
   - Same expanded detail rhythm.
   - Same sidebar dimensions.
   - Same tab treatment.

2. **No rounded corners by default.**
   - Default radius is `0`.
   - Do not use pills for normal controls.
   - If a badge needs slight rounding, justify it locally and keep it minimal.

3. **One shell, one sidebar.**
   - No nested topbars.
   - No iframe-style app embedding.
   - No Beads project sidebar inside a console view that already has a repo rail.
   - No Git repo sidebar inside a console view that already has a repo rail.

4. **Rows are the primary object.**
   - Both Git and Beads modules are list/feed-first.
   - Kanban is secondary only.

5. **Details expand inline.**
   - Details scroll with the page/list.
   - Avoid boxed inner scroll regions.

6. **Professional FUI, not decorative FUI.**
   - Thin borders.
   - Quiet state rails.
   - Sparse accent use.
   - Minimal animation.

## Design tokens

```css
:root {
  --bg: #181818;
  --surface-1: #181818;
  --surface-2: #1b1b1b;
  --surface-3: #202020;
  --surface-hover: #222222;
  --surface-selected: #242424;

  --border-subtle: rgba(255, 255, 255, 0.07);
  --border: rgba(255, 255, 255, 0.11);
  --border-strong: rgba(255, 255, 255, 0.18);

  --text-primary: #e6e6e6;
  --text-secondary: #a7a7a7;
  --text-muted: #757575;
  --text-disabled: #505050;

  --accent: #8ed2dc;
  --accent-muted: rgba(142, 210, 220, 0.18);

  --success: #7fbf8f;
  --warning: #d6b36a;
  --danger: #d1847f;
  --epic: #b69adf;

  --radius: 0;

  --topbar-height: 44px;
  --sidebar-width: 238px;
  --row-height: 52px;

  --font-ui: Inter, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", monospace;

  --text-xs: 11px;
  --text-sm: 12px;
  --text-base: 13px;
}
```

Compatibility aliases may exist while migrating older components, but new components should use the canonical token names above.

## Shell layout

Target structure:

```text
┌────────────────────────────────────────────────────────────┐
│ xtrm.wtf        Git   Beads   Reports   Agents             │ 44px
├───────────────┬────────────────────────────────────────────┤
│ repo rail     │ module content                             │
│               │                                            │
│               │ row                                        │
│               │ row                                        │
│               │ expanded inline dossier                    │
│               │ row                                        │
└───────────────┴────────────────────────────────────────────┘
```

Rules:

- One topbar only.
- One left rail only.
- Module tabs are text tabs with a one-pixel active underline.
- No filled tab pills.
- Module content starts flush against the shared rail edge.
- Background remains `#181818` across the entire shell.

## Shared repo rail

Width: `238px`.

Row structure:

```text
status-dot  repo-name                     GH BD
            pr-count issue-count bead-count
```

Rules:

- Square edges.
- Left active rail: `2px solid var(--accent)`.
- No rounded cards.
- No nested project rails in module content.
- Selected repo filters every module.

## Row anatomy

Collapsed row:

```text
│ status rail │ id/number │ title                            │ metadata │ state │ chevron │
```

Recommended grid:

```css
grid-template-columns: 18px 86px minmax(0, 1fr) auto minmax(120px, auto) 22px;
min-height: var(--row-height);
padding: 8px 12px 8px 14px;
border-bottom: 1px solid var(--border-subtle);
background: var(--surface-1);
border-radius: 0;
```

States:

- Hover: `--surface-hover`.
- Selected/expanded: `--surface-selected` or a very subtle left-to-right accent wash.
- Status is shown by a thin left rail, not large colored cards.

## Git row mapping

Git PR row should use the shared row anatomy:

```text
│ rail │ #123 │ PR title                         │ author · updated │ OPEN │ chevron │
```

Expanded Git dossier:

```text
Summary
Conversation
Reviews
Commits
Files
Linked beads
Metadata
```

## Beads row mapping

Bead issue row should use the same shared row anatomy:

```text
│ rail │ forge-abc │ issue title                  │ owner · updated │ READY │ chevron │
```

Expanded Beads dossier:

```text
Description
Notes
Dependencies
Blocks
Parent / epic
Children
Linked PRs
Metadata
```

## Expanded dossier anatomy

Use the same visual structure in Git and Beads:

```text
Section label        small uppercase, muted
Section body         12-13px, readable line height
Metadata             compact key/value rows
Dependency links     square chips / rows, not pills
```

Rules:

- No inner scrolling areas for normal detail text.
- No rounded cards.
- Dossier sections should feel attached to the row, not like separate floating cards.
- Markdown renders cleanly and quietly.

## Tabs

Module tabs:

```text
Git    Beads    Reports    Agents
```

Style:

```css
height: 100%;
padding: 0 10px;
border-bottom: 1px solid transparent;
font-size: 12px;
font-weight: 600;
letter-spacing: 0.04em;
```

Active:

```css
border-bottom-color: var(--accent);
color: var(--text-primary);
```

Do not use filled rounded active states.

## Banned patterns

Do not introduce:

- iframe module composition
- nested sidebars
- nested topbars
- blue-black gradient app backgrounds
- large glowing borders
- pill-heavy controls
- rounded card grids as primary navigation
- separate Beadboard/Gitboard spacing scales
- separate Beadboard/Gitboard color palettes
- decorative HUD panels that do not carry data
- emoji status markers

## Migration guardrails

Implementation must happen in this order:

1. **Document contract** — this file.
2. **Normalize tokens** in both apps without changing layout behavior.
3. **Normalize row/list primitives** in both apps while keeping routes separate.
4. **Normalize expanded dossier sections** in both apps.
5. **Create a true shared shell** as one React app/module system.
6. **Move Git and Beads into the shell** without iframes.
7. **Remove old per-app chrome** only after modules render inside the real shell.

Do not skip directly to a unified shell by embedding one app inside another.

## Acceptance checklist for future work

Before marking any console UI work done:

- [ ] Git and Beads use the same base background.
- [ ] Git and Beads use the same row height and row border style.
- [ ] Git and Beads use square edges.
- [ ] There is only one topbar.
- [ ] There is only one sidebar.
- [ ] No iframe embedding is used for module composition.
- [ ] Expanded details use the same section rhythm.
- [ ] Kanban, if present, is secondary and visually subordinate to the feed.
- [ ] `/gitboard` and `/beadboard` remain stable until the true shell replaces them.
