# OrpheusDesign

The design-system layer of [Orpheus](../../README.md). Every UI module in
the project — present and future — imports `OrpheusDesign` and uses its
tokens and components. **No stock SwiftUI controls in user-facing code,
ever.** That rule is what keeps Orpheus visually distinctive across
phases; this package is what makes it enforceable.

Phase 0 builds it. Feature phases consume it. Phase 7 polishes it.

## Quick start

```bash
cd packages/OrpheusDesign
swift build                            # build the library + catalog
swift test                              # token + lint + smoke tests
swift run OrpheusDesignCatalog          # open the catalog window
```

The catalog app shows every token and every component side-by-side in
both dark and light themes. It's the human-verifiable gate for the
design system: if something looks wrong in the catalog, fix it there
before the next phase consumes it.

## Importing

The package vends one library product:

```swift
import OrpheusDesign
```

In a downstream `Package.swift`:

```swift
.package(path: "../OrpheusDesign"),
```

…and depend on the `OrpheusDesign` target.

## Token surface

| Namespace | What it covers |
|---|---|
| `OrpheusColor` | Theme-aware semantic colours: `.Surface.*`, `.Text.*`, `.Border.*`, `.Accent.*`, `.Semantic.*`, `.Glass.*`. Each token returns an `OrpheusThemedColor` carrying both dark and light components. |
| `OrpheusPalette` | Raw palette data (`.dark` / `.light` instances) — used by the catalog and tests when an explicit half is needed without theme resolution. |
| `OrpheusTypography` | 6-step type ramp (`display`, `title`, `heading`, `body`, `caption`, `mono`) backed by Satoshi (sans) + Commit Mono (mono) with system fallback. |
| `OrpheusSpacing` | 4-pt grid, `.none` … `.huge` (0, 4, 8, 12, 16, 24, 32, 48, 64). |
| `OrpheusRadius` | `none`, `chip`, `button`, `card`, `modal`, `pill` (0, 4, 6, 8, 12, half-height). |
| `OrpheusMotion` | `quick`, `standard`, `settle`, `dramatic` spring presets. |
| `OrpheusMaterial` | `sidebar`, `palette`, `toolbar`, `overlay` — Liquid-Glass-aware materials. |
| `OrpheusIcon`, `OrpheusIconSlot` | SF Symbol wrapper plus named slots for Orpheus-specific concepts (project, space, terminal, fork, self-drive). |
| `OrpheusTheme` | Bundles a `ColorScheme` and `OrpheusPalette`; `.dark` and `.light` instances ship with the package. |

### Token usage cheatsheet

```swift
view
    .orpheusForeground(OrpheusColor.Text.primary)
    .orpheusBackground(OrpheusColor.Surface.elevated)
    .orpheusBorder(OrpheusColor.Border.default,
                   width: 1, cornerRadius: OrpheusRadius.button)
    .orpheusFont(OrpheusTypography.body)
    .orpheusCornerRadius(OrpheusRadius.card)        // use OrpheusRadius.pill for half-height
    .orpheusMaterial(.sidebar)

withAnimation(OrpheusMotion.standardAnim) { state.toggle() }

OrpheusIcon(systemName: "magnifyingglass",
            size: .medium,
            color: OrpheusColor.Text.tertiary)

OrpheusIconSlot.terminal()                          // theme-aware default
```

## Component catalog

Form: `OrpheusButton`, `OrpheusToggle`, `OrpheusTextField`, `OrpheusTextArea`, `OrpheusMenu`.

Layout: `OrpheusList`, `OrpheusRow`, `OrpheusSplitView`, `OrpheusSidebar`, `OrpheusSpaceSwitcher`.

Overlay: `OrpheusModal`, `OrpheusSheet`, `OrpheusCommandPalette`, `OrpheusTooltip`.

Status / chrome: `OrpheusStatusBadge`, `OrpheusQuickAction`, `OrpheusText`, `OrpheusIcon`.

Motion / feedback: `OrpheusSpinner`, `OrpheusProgressBar`, `OrpheusSkeleton`, `OrpheusToast`, `OrpheusBanner`.

Each component file ends with `#Preview` blocks for both themes and the
states it exposes; open it in Xcode to iterate visually.

## Discipline rules (the binding ones)

The eight rules from `extras/specs/design-principles.md`. PRs that
violate any of these get rejected at review.

1. **Never use stock SwiftUI controls in user-facing code.** `Button {}`,
   `Toggle`, `TextField`, `List`, `Menu` are forbidden — always
   `OrpheusButton`, `OrpheusToggle`, etc. Internal `Button` as a tap
   handler inside an Orpheus component is fine when wrapped in
   `.buttonStyle(.plain)` so no system chrome leaks.
2. **Never import raw hex colours.** All colour through `OrpheusColor`.
3. **Never use raw px values for spacing.** Always `OrpheusSpacing`.
4. **Never use system font.** Always `OrpheusTypography`.
5. **Never use default SF Symbol colour or weight.** Always specify a
   token via `OrpheusIcon`.
6. **Every animation uses `OrpheusMotion.<token>`.** Documented
   exceptions only.
7. **Every icon referenced by token name,** not SF Symbol string or
   asset name directly.
8. **No web-stack escape hatches.** Native is the only rendering path
   in v0.

The `DisciplineLintTests` xctest target enforces the 1, 2, 4, 6, 7
rules with a string scan of `Sources/OrpheusDesign/Components/`. Run
`swift test` to verify before pushing.

## Theme handling

```swift
ContentView()
    .orpheusTheme(.dark)        // explicit dark
    .orpheusTheme(.light)       // explicit light
    .orpheusTheme(nil)          // follow system
```

The `.orpheusTheme(_:)` modifier sets both the SwiftUI `colorScheme`
environment and the package's `orpheusTheme` environment value. Tokens
resolve through `Environment(\.orpheusTheme)`, so a sub-tree can
override the active theme without affecting the rest of the window —
useful for the catalog's side-by-side dark/light comparison.

## Catalog (`OrpheusDesignCatalog`)

Executable target inside the package. `swift run OrpheusDesignCatalog`
opens a window showing every token and every component in both themes.
This is the Phase 0 visual gate — if a component looks wrong in the
catalog, it's wrong in production.

## Phase 0 status

Built per `extras/agent-briefs/v0/` in the planning repo. Gate criteria
and known spec gaps are reported in
`projects/orpheus/sessions/<date>-review-phase-0-design-system-build.md`.

## Fonts

Satoshi (sans) and Commit Mono (mono) are the LOCKED v0 typeface pair.
The package ships **without** font binaries — Satoshi licensing is
commercial and must be verified per project before embedding; Commit
Mono is OFL but isn't yet bundled. With the binaries absent the package
falls back to the system sans + monospaced faces at the same sizes and
weights, so layout and ramp shape are preserved.

Drop the `.otf` / `.ttf` files into
`Sources/OrpheusDesign/Resources/Fonts/` and the registry picks them up
on next launch — no other change needed.
