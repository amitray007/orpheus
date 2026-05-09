# Phase 0 — Design-System Foundation (`OrpheusDesign`)

**Role:** You are a build agent implementing the foundational design system for Orpheus, a closed-source Mac IDE built around Claude Code.
**Output:** a standalone **Swift Package** called `OrpheusDesign` that every downstream Orpheus module imports.

**Scope in one sentence:** build every design token and every base component, fully custom (never stock SwiftUI), supporting dark + light themes, so that feature phases after this one start from `OrpheusDesign` and never touch stock SwiftUI controls.

---

## Why this phase exists

Orpheus's aesthetic is fully custom across typography, colors, materials, motion, iconography, and layout. Reference aesthetics: Raycast (closest), Ghostty, Cursor 3, Things 3, Arc, Ivory, cmux. macOS 26 Liquid Glass selectively. Dark-mode primary. The rule — **never stock SwiftUI controls** — is the discipline that keeps Orpheus distinctive. This phase makes that rule enforceable by producing the only design components downstream phases are allowed to use.

---

## Reading order

Before doing anything, read in this order:

1. **`inputs.md`** (this folder) — the exact set of files to read with locked status.
2. **`docs/specs/design-principles.md`** — LOCKED design tokens + material tuning + discipline rules. Non-negotiable source of truth.
3. **`docs/specs/architecture.md`** — stack context (AppKit + SwiftUI interop, libghostty, fully native rich content, `OrpheusDesign` Swift Package layer).
4. **`docs/plan.md` → Phase 0 section** (lines 68-108) — official deliverables + gate criteria.
5. **`tasks.md`** (this folder) — concrete task breakdown derived from the plan.
6. **`discipline.md`** (this folder) — hard rules + common pitfalls.
7. **`handoff.md`** (this folder) — what to produce, where it goes, how to report done.

---

## What "done" looks like

Gate criteria from `plan.md` Phase 0:

- [ ] Every token category locked with values.
- [ ] Core component set compiles with preview samples.
- [ ] Dark + light palettes both complete at the token level.
- [ ] No stock SwiftUI controls referenced in the design-system package.

Plus the usability gate: a **catalog preview app** showing every component in both themes, rendering correctly. A human can open it and see the full component library.

---

## Non-goals for Phase 0

- **No feature code.** This phase only builds the design system. Shell + terminal + core plumbing come in Phase 1-2.
- **No custom logotype / logomark.** Deferred to Phase 7.
- **No full custom-drawn icon catalog.** Deferred to Phase 7. Use SF Symbols + a small set of placeholder custom icons for Orpheus-specific concepts (project, space, terminal, fork, self-drive).
- **No terminal ANSI color scheme.** Deferred to Phase 2 (terminal colors get their own tuning pass there).

---

## Companion phases

- **Phase 1 (Core Foundation)** runs in parallel to Phase 0 since it's headless. A separate build agent can own it; briefs will land in `agent-briefs/v1/` when that phase starts.
- **Phase 0.5 (Wireframes)** is **already complete** — see `agent-briefs/v0.5/README.md`. Wireframes are the source of truth for what components this design system must ultimately render.
