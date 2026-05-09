# Phase 0 — Inputs to read before writing any code

All paths are relative to the Orpheus code-repo root (`/Users/maverick/code/projects/orpheus/`). Documentation lives under `docs/`. Phase reports go to the thoughts repo at `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/` per `handoff.md`.

## Primary sources of truth (LOCKED — treat as contract)

### `docs/specs/design-principles.md`
**LOCKED.** The authoritative design-tokens document. Contains:
- Typography system: Satoshi (sans) + Commit Mono (mono); 6-step type ramp (display / title / heading / body / caption / mono).
- Color palette: full semantic token set for surface / text / accent (Lyre Gold) / semantic (success, warning, danger, info) / terminal / code-highlight. Dark + light starter hex values.
- Material tuning: `sidebar`, `palette`, `toolbar`, `overlay` — blur radii, tint opacities, saturation, rim lighting.
- Motion tokens: `quick`, `standard`, `settle`, `dramatic` spring presets.
- Spacing + radius scales: 4px base grid.
- Iconography: SF Symbols curation rules + Orpheus-specific placeholder slots.
- Discipline rules: 8 rules including "never stock SwiftUI controls."

**Every token you implement maps to a value in this file.** If a token you need isn't here, treat it as a spec gap — raise in your handoff report, don't invent.

### `docs/specs/architecture.md`
**LOCKED.** Technical context. Relevant sections for Phase 0:
- Stack: AppKit + SwiftUI interop via `NSHostingView` / `NSViewRepresentable`.
- `OrpheusDesign` Swift Package is the **design layer** of the 8-layer stack.
- `OrpheusRichContent` (syntax highlighting via TextKit 2 + SwiftTreeSitter, Swift Charts, custom `Canvas` heatmap, AttributedString Markdown) is a **consumer** of `OrpheusDesign` — Phase 0 doesn't implement these, but the design system should anticipate them (e.g., code-highlight tokens exist for them to use).
- Target platform: **macOS 14+** (verify against spec if ambiguous). macOS 26 Liquid Glass materials used selectively.

### `docs/plan.md` → Phase 0 section (lines 68-108)
**LOCKED.** Official deliverables + gate criteria. Read this **verbatim**. Your task list in `tasks.md` expands on this — anything in `plan.md` Phase 0 that isn't in `tasks.md` is an oversight, raise it.

## Reference — what the design system must ultimately render

### `docs/wireframes/wireframes-v0.5.md`
**LOCKED.** 22 active v0 wireframes showing every UI surface. Skim all 22 to understand what's coming; focus on:
- **W1, W2** (Dashboard empty + populated) — tests your sidebar, project list, heatmap, cards.
- **W4** (Chat viewer + Quick Actions footer) — the most load-bearing surface; tests tabs, chat rendering, tool-use summaries, footer layout, ambient usage counter.
- **W5** (Sessions browser) — split-view list/detail.
- **W9** (Command palette, ⌘K) — 80-char overlay; tests modal materials, search input, grouped list.
- **W12, W13** (Settings windows) — tests left-sidebar category list + right-pane content, radio groups, toggles, buttons.
- **W19** (State patterns reference) — empty state, loading skeleton, error toast, error banner. Your skeleton + toast components must match.

Phase 0 **doesn't build** these surfaces — but it builds the **components** that will render them. Knowing where each component will appear sharpens the design.

### `docs/future-scope.md`
**READ-ONLY reference.** Deferred features (post-v0). Good for answering "is this my scope?" — anything in `future-scope.md` is not Phase 0.

## Companion spec (skim)

### `docs/specs/quick-actions.md`
Defines the three execution modes for Quick Actions (orchestration / inject / hybrid). Phase 0 builds the **visual chip component** (`OrpheusQuickAction` or similar) used in the Quick Actions footer. The execution modes themselves are Phase 4.

## External references (consult as needed)

- Apple HIG — macOS 26 Liquid Glass usage guidelines.
- SF Symbols app (6.0+) — icon glyph catalog.
- Satoshi typeface — **license check required** before embedding in the Swift Package. Commit Mono is OFL, embed freely.

## Not inputs for this phase

- Terminal ANSI color schemes — Phase 2 decision.
- Code syntax theme — Phase 5 decision.
- Final logotype — Phase 7 decision.
- Voice HUD-specific components — mostly Phase 6; W20/W26 wireframes inform a future chip component but implementation is later.
