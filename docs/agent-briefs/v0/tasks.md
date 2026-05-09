# Phase 0 — Task breakdown

Concrete tasks derived from `docs/plan.md` Phase 0 deliverables + gate criteria. Work them roughly top-to-bottom, but the groups after "Scaffold" can be parallelized (typography, colors, materials, motion all independent).

## Group 1 — Scaffold

1. **Scaffold the `OrpheusDesign` Swift Package.**
   - `Package.swift` with products: library `OrpheusDesign`, executable `OrpheusDesignCatalog` (preview app).
   - Directory layout:
     - `Sources/OrpheusDesign/Tokens/`
     - `Sources/OrpheusDesign/Components/`
     - `Sources/OrpheusDesign/Materials/`
     - `Sources/OrpheusDesign/Theme/`
     - `Sources/OrpheusDesignCatalog/` (preview app entry point)
     - `Tests/OrpheusDesignTests/`
   - Minimum deployment target per architecture spec (macOS 14+ unless spec says otherwise).
   - No external dependencies in `Package.swift` for v0 (fully native). If you need one, flag it in handoff.

## Group 2 — Tokens

Every token category in `design-principles.md` gets a Swift type + values.

2. **Color tokens.** Namespaced `OrpheusColor.{surface, text, accent, semantic, terminal, code}` enums or structs. Dark + light values. Every hex from the LOCKED palette in `design-principles.md` mapped to a semantic name (e.g., `OrpheusColor.surface.background`, `OrpheusColor.text.primary`, `OrpheusColor.accent.lyreGold`).
3. **Typography tokens.** 6-step ramp: `display`, `title`, `heading`, `body`, `caption`, `mono`. Each as a `Font` value. Fonts loaded from embedded Satoshi + Commit Mono files.
4. **Spacing + radius tokens.** 4px base grid: `OrpheusSpacing.{xs, sm, md, lg, xl, xxl}`. Radii: `OrpheusRadius.{sm, md, lg, pill}`.
5. **Shadow tokens** (if specified in design-principles — check; if not, minimal stub).
6. **Motion tokens.** Four spring presets: `quick`, `standard`, `settle`, `dramatic`. Exposed as `Animation` values + raw spring parameters.
7. **Material tokens.** Four custom-tuned materials — `sidebar`, `palette`, `toolbar`, `overlay` — each with blur radius, tint color, tint opacity, saturation, rim-light params. Layered on macOS Liquid Glass where available; fallback for older macOS versions.
8. **Icon tokens.** SF Symbols wrapper + placeholder slots for project / space / terminal / fork / self-drive glyphs. Glyphs themselves can be text placeholders for v0 (custom-drawn icons are Phase 7).

## Group 3 — Theme system

9. **Theme type.** `OrpheusTheme` struct bundling all tokens. Two instances: `.dark`, `.light`. Environment key for propagation.
10. **Theme switcher.** Follows system by default (`@Environment(\.colorScheme)`). Explicit `.dark` / `.light` override via environment.
11. **Accessibility contrast verification.** Unit test: every text-on-surface color pair meets WCAG AA (4.5:1 for body, 3:1 for large text).

## Group 4 — Base components

Each component:
- Lives in `Sources/OrpheusDesign/Components/<Name>/`.
- Has at least one `#Preview` covering primary states (hover, pressed, disabled, loading if applicable) in both themes.
- Uses only `OrpheusDesign` tokens — no hard-coded colors/fonts/spacing.
- Never wraps a stock SwiftUI control (see `discipline.md`).

12. **`OrpheusButton`** — primary, secondary, tertiary, destructive variants. Sizes: sm / md / lg. States: idle / hover / pressed / disabled / loading.
13. **`OrpheusToggle`** — checkbox, radio, switch variants.
14. **`OrpheusTextField`** — single-line input with optional leading icon, placeholder, focus ring.
15. **`OrpheusTextArea`** — multi-line input.
16. **`OrpheusList`** — vertical list container with variants (inset, plain, sidebar). Built on `LazyVStack` + custom row rendering.
17. **`OrpheusRow`** — list row primitive (leading icon / content / trailing / chevron / selection state).
18. **`OrpheusMenu`** — popover menu + context menu.
19. **`OrpheusSplitView`** — horizontal / vertical split with draggable divider.
20. **`OrpheusSidebar`** — the left-rail structure from wireframes (nav items + sections + bottom actions).
21. **`OrpheusSpaceSwitcher`** — the nested project/space list component used inside `OrpheusSidebar` (consumes expand/collapse chevron, activity indicators `/`, `-`, `*`, `o`, `.`).
22. **`OrpheusCommandPalette`** — ⌘K overlay shell (80-char wide modal per W9). Search input + grouped results. Doesn't implement search logic; exposes slots for injected data.
23. **`OrpheusQuickAction`** — chip styled for the Quick Actions footer strip (label + optional glyph).
24. **`OrpheusStatusBadge`** — small chip for state (on/off/live/dormant).
25. **`OrpheusTooltip`** — standard hover tooltip.
26. **`OrpheusModal`** — centered modal overlay (W10, W11 new-project/new-space pattern).
27. **`OrpheusSheet`** — native macOS sheet wrapper styled with Orpheus tokens.

## Group 5 — Motion + feedback

28. **`OrpheusSpinner`** — `/` `-` `\` `|` cycle animation rendered as a vector. Respects motion tokens.
29. **`OrpheusProgressBar`** — determinate + indeterminate variants.
30. **`OrpheusSkeleton`** — gray-block + shimmer animation placeholder (matches W19 loading-skeleton pattern).
31. **`OrpheusToast`** — transient notification (matches W19 error-toast pattern). Stacks.
32. **`OrpheusBanner`** — persistent inline banner (matches W19 error-banner pattern).

## Group 6 — Catalog preview app

33. **`OrpheusDesignCatalog` preview app.** A small SwiftUI app that renders every component in both themes, grouped by category (Tokens / Components / Motion). Each section has labeled examples covering primary states. Theme switcher at the top. A human should be able to `swift run OrpheusDesignCatalog` and see the entire design system on screen in both themes.

## Group 7 — Documentation + tests

34. **README in the Swift Package** describing the discipline rules (from `discipline.md` and `design-principles.md`) — this is the "design-discipline documentation" deliverable in `plan.md`.
35. **Unit tests for tokens** — font loading, contrast ratios, spacing/radius values match spec.
36. **Snapshot tests for components** (if practical) — catches visual regressions on state changes.

---

## Out of scope (flag if you hit them)

- Terminal-specific components (ANSI rendering, cursor, scrollback) — Phase 2.
- Chat viewer internals (tool-use accordions, file-link rendering, turn timing) — Phase 3.
- Heatmap rendering (GitHub-style grid via `Canvas`) — Phase 4.
- Diff rendering — Phase 5 (actually built on top of `OrpheusDesign` primitives).
- Custom-drawn icon catalog — Phase 7.

If a task in this list can't be completed without touching out-of-scope code, **stop and flag it in your handoff report**.
