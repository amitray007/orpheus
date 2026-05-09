# Phase 0.5 — Wireframes & Flows

**Status: ✅ COMPLETE.** Produced via interactive design sessions (2026-04-17 through 2026-04-19). No build agent was needed for this phase.

---

## The artifact

**`docs/wireframes/wireframes-v0.5.md`** — the canonical wireframe document.

Contents:
- **22 active v0 wireframes, ✅ all locked** across 13 iterations.
- **4 wireframes 📦 archived** (Extensions browser, Git surfaces, Automations, Ideas Inbox) — designs preserved; deferred post-v0; rationale in `docs/future-scope.md`.
- **Product principles** block at the top of the wireframes file — unrestricted multi-session, flow-first creation, gated modals.
- **ASCII conventions** documented at the top (sidebar width 28, main width 71, total 102; symbols for status glyphs, spinner frames, project-logo stand-ins, tab-focus indicators, etc.).
- **Iteration history** log at the top, newest-first.
- **Removed from canonical flow** section preserving deprecated patterns with rationale.
- **Open design decisions** captured for Phase 0.5 resolution in future iterations.

## How downstream agents should use this artifact

For any feature phase that builds a UI surface:

1. **Find the relevant wireframe(s)** in `wireframes-v0.5.md`. Index table at the top of that file.
2. **Treat the wireframe as the layout contract** — widths, proportions, icon positions, interaction patterns.
3. **Use `OrpheusDesign` components** (from Phase 0 build) to render them. Never diverge from the token system.
4. **Honor the product principles** — never restrict to "one of X", flow-first creation, gated modals.
5. **Consult behavior specs** (companion docs in `docs/specs/`) for mechanics beyond layout (e.g., `quick-actions.md` for Quick Actions execution modes).

## Wireframes index (as of 2026-04-19, final)

**Active v0 (22 locked):**

| # | Name |
|---|---|
| 1 | Dashboard (empty — no projects) |
| 2 | Dashboard (with projects + activity) |
| 3 | Empty space — session picker |
| 4 | Chat viewer + Quick Actions footer |
| 5 | Sessions browser (split view with preview) |
| 6 | Terminal view (raw) |
| 7 | Split terminals — horizontal |
| 8 | Split terminals — vertical |
| 9 | Command palette (⌘K) |
| 10 | New-project modal |
| 11 | New-space modal |
| 12 | Settings window — Global |
| 13 | Project Settings window |
| 14 | Menubar dropdown — Now (default) |
| 15 | Menubar dropdown — Projects |
| 16 | Menubar dropdown — Sessions |
| 17 | Main window — canvas mode |
| 18 | Onboarding — first-run welcome |
| 19 | State patterns reference (empty / loading / error) |
| 20 | Voice HUD — Full (hovering overlay) |
| 21 | Diff viewer (diffs.com-style, collapsible files) |
| 26 | Voice HUD — Compact (toolbar chip, default) |

**Archived post-v0 (4 wireframes, designs preserved in the doc):**

| # | Name |
|---|---|
| 22 | Extensions browser (MCP / Skills / KB) |
| 23 | Git surfaces (PRs / Issues / Actions / Branches) |
| 24 | Automations (Rules / Schedule / Running) |
| 25 | Ideas Inbox (capture + scaffold) |

## Companion specs

- **`docs/specs/architecture.md`** — tech stack; what `OrpheusCore` knows about layouts.
- **`docs/specs/design-principles.md`** — tokens that render the wireframes.
- **`docs/specs/quick-actions.md`** — execution-mode semantics for actions shown in Wireframe 4's footer.
- **`docs/future-scope.md`** — why W22-W25 are archived and what triggers a revisit.

## Why no build agent

Wireframes are a design artifact, not a buildable target. They're produced by iterative to-and-fro between a human + assistant, not by a build agent executing a brief. This folder exists to establish the **same-location pattern** as other phases (`v0`, `v1`, etc.) and to point downstream agents at the artifact.

---

## Companion file: `lore.md`

The wireframes file captures *what*. Sessions capture *when*. **`lore.md`** (this folder) captures *why* — the conversational and decision context from the 13 iterations that isn't otherwise preserved:

- Decision chains + reversals (why we landed where we did — flow-first `[+]` → dual buttons, Initial-terminals radio → checkboxes, menubar flat → tabbed, Canvas chrome diet, etc.)
- ASCII conventions reference (every glyph, width, divider, tag)
- Product principles + product insights
- Cross-wireframe relationships (what shares structure)
- Unresolved spec gaps (project count semantics, logo algorithm, forking flow placement, etc.)
- Terminology glossary (terminal / session / space / project / same-PTY rule)
- Iteration timeline (1-13 one-liners)

**Read `lore.md` before touching wireframes after a long gap** — especially if you're considering changes that a prior iteration already resolved.
