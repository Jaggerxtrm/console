Here's a clean reference graph stripped to the demonstrative essentials: 8 issues + 2 external chips, all 9 relationship types exercised once, one running agent, layered left-to-right.The implementation rules behind it:

**Node anatomy.** Each issue node is a horizontal cell with, left to right: a 3px priority band on the left edge (P0 red / P1 amber / P2 dim), a state glyph (`◯` ready, `◐` wip, `◇` blocked, `⊡` gate, `◈` epic, `✓` closed, `✕` superseded), the ID with prefix dim and suffix bright, the title, an agent badge (colored dot + `role/instance`), and a priority text tag. Total height ~28px; width should be enough to fit a moderately-truncated title without resizing per-node.

**Running detection.** A node is "running" when its assigned agent is actively working on it. Visually, two things pulse at 1.6s ease-in-out: a small dot prepended to the ID and the agent badge's color dot. Other queued-but-not-running nodes show the agent badge static. This is the only animation in the graph — it should never be ambient elsewhere, so the running node is unambiguously locatable.

**Closed and superseded.** Closed nodes render at ~45% opacity with dashed border. Superseded gets the same fade plus a strikethrough on the title. Both remain in the graph because they're referenced as edge endpoints — they're context, not work.

**External targets.** When `tracks` or `until` point at something outside the bd database (a repo path, a release name, a calendar date), render those targets as pill-shaped chips with dashed borders, not as full node rows. They aren't beads and shouldn't look like them. `until` targets specifically inherit the amber `until`-edge color so the temporal relationship is reinforced.

**Edge encoding.** Color per relationship type, shape by hardness:

- **Solid** for hard or causal relationships: `blocks` (red, 2px stroke and bumped to 2.5px when on a critical P0-only chain), `caused-by` (red-brown), `validates` (blue), `supersedes` (muted purple), `discovered-from` (purple).
- **Dashed** for soft or time-bound: `tracks` (green), `until` (amber).
- **Dotted-dim** for structural or informational: `parent-child` (small-dot circle marker, gray, very faint — it carries no scheduling weight so it shouldn't compete visually with `blocks`), `related` (gray dotted, no arrowhead since the relation is symmetric).

**Arrowhead direction is invariant.** Always source → effect: `blocks` from blocker to blocked; `caused-by` from cause to symptom; `validates` from validator to validated; `supersedes` from new to old; `discovered-from` from origin to spawned; `parent-child` from parent to child; `tracks` from tracker to external target; `until` from gated issue to deadline. `related` has no head. One rule across all nine types — if you're unsure of direction, follow time / causality.

**Layered layout.** Topological depth computed *only over `blocks` edges* — that's the single rel type that constrains the scheduler. L0 = nodes with no incoming `blocks`; L1 = blocked directly by L0; L2 = further downstream, plus external chips and closed/superseded nodes. Other edge types (parent-child, caused-by, validates, tracks, until, discovered-from, supersedes, related) freely cross layers without forcing layer changes. This keeps the column position meaningful: "left = pickable now, right = waiting on something."

**Multi-edge between the same pair.** Demonstrated by the `ye5s9 ↔ 1j9om` pair, which has both a `parent-child` edge (epic owns child) and a `validates` edge (child validates epic). Render as two separate paths, arced in opposite directions vertically (top arc for one, bottom arc for the other) with their labels offset to the outside of each arc. Don't merge them — each relationship deserves its own visible line.

**The agent badge color palette** is intentionally distinct from edge colors so they don't read as related concepts: edges are issue-to-issue links, agent badges are person-to-issue assignments. Reusing colors between the two domains would be visually noisy.

**What this reference does not show but is worth handling in your implementation.** Hover should highlight all incident edges and dim the rest; clicking a node should expose a focused subgraph (its full ancestor + descendant chain). At 50+ nodes the graph needs filtering (chips per edge type, per agent, per priority) — the v3 file in your scrollback has those chips if you want a reference for that layer.
