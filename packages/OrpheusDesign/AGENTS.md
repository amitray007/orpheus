# Component conventions for OrpheusDesign

These rules apply to every component file in `Sources/OrpheusDesign/Components/`. They make the package legible across many contributors and enforce the LOCKED design discipline (`docs/specs/design-principles.md` at the repo root).

## File layout

- One component per file: `Sources/OrpheusDesign/Components/OrpheusXXX.swift`.
- Public type is `public struct OrpheusXXX: View`.
- Variants and sizes are nested enums: `OrpheusButton.Variant`, `OrpheusButton.Size`. Conform them to `Sendable, Equatable`.
- Initializer is `public init(...)` with sensible defaults — `isEnabled: Bool = true`, `size: Size = .medium`, etc.
- Each file ends with at least two `#Preview` blocks: one for dark, one for light, wrapping content in `.orpheusTheme(.dark)` / `.orpheusTheme(.light)`. Cover main states (idle / hover / pressed / disabled / loading where applicable).

## What's banned

The discipline rules in `docs/specs/design-principles.md` and the `discipline.md` brief forbid stock SwiftUI controls in user-facing chrome. Concretely:

- **No `Button {}`** as visible chrome. You may use it as an internal tap target if you wrap the visible body yourself and apply `.buttonStyle(.plain)` so no system styling is rendered.
- **No `Toggle {}`** at all in components — implement the switch yourself with `RoundedRectangle` + `Circle` + `.onTapGesture`.
- **No `TextField {}` / `TextEditor {}`** in user-facing chrome. Wrap `NSTextField` / `NSTextView` via `NSViewRepresentable` and style every visible pixel with tokens.
- **No `List {}`, `Menu {}`, `Form {}`, `NavigationStack`, `NavigationSplitView`, `TabView`, `DisclosureGroup`** — implement the layout yourself with `VStack`/`HStack`/`ZStack`/`LazyVStack`/`LazyHStack`/`ScrollView`/`GeometryReader`.
- **No `.foregroundStyle(.white)`, no `Color.white`/`Color.black`/`Color.blue`** anywhere outside `Tokens/`. Always go through `OrpheusColor.<category>.<token>`.
- **No `.font(.system(...))`** in components. Use `OrpheusTypography.<style>` via `.orpheusFont(_:)`.
- **No raw px values for spacing / radius**. Use `OrpheusSpacing.<token>` and `OrpheusRadius.<token>`.
- **No bare `Image(systemName:)`** outside `OrpheusIcon` / `OrpheusIconSlot`.
- **No `.regularMaterial`, `.thinMaterial`** etc. Use `.orpheusMaterial(.sidebar)` / `.orpheusMaterial(.palette)` / etc.

## Token consumption

```swift
.orpheusForeground(OrpheusColor.Text.primary)            // theme-aware foreground
.orpheusBackground(OrpheusColor.Surface.elevated)         // theme-aware background
.orpheusBorder(OrpheusColor.Border.default,
               width: 1, cornerRadius: OrpheusRadius.button)
.orpheusFont(OrpheusTypography.body)
.orpheusCornerRadius(OrpheusRadius.card)                  // pass `OrpheusRadius.pill` for half-height
.orpheusMaterial(.sidebar)
```

Reading the active theme directly:
```swift
@Environment(\.orpheusTheme) private var theme
let bg = theme.scheme == .dark
    ? OrpheusColor.Surface.elevated.darkColor
    : OrpheusColor.Surface.elevated.lightColor
```

Animations:
```swift
.animation(OrpheusMotion.standardAnim, value: someState)   // .quickAnim, .settleAnim, .dramaticAnim
withAnimation(OrpheusMotion.quickAnim) { isHovered = true }
```

## Interaction patterns

- Hover tracking: `@State private var isHovered = false` + `.onHover { ... }` wrapped in `withAnimation(OrpheusMotion.quickAnim)`.
- Press tracking: `DragGesture(minimumDistance: 0)` so press visual fires before the tap completes.
- Focus: bind `@FocusState` and draw a custom focus ring (gold, `OrpheusColor.Accent.primary`, 2pt outline). Never rely on the system blue ring.
- Reduce motion: when `@Environment(\.accessibilityReduceMotion)` is `true`, replace spring animations with a no-op transition.

## Accessibility

- Every interactive element has `.accessibilityLabel(...)`.
- Add `.accessibilityAddTraits(.isButton)` (or the right trait) for non-`Button`-backed controls.
- VoiceOver-relevant state (selected, expanded, etc.) goes through `.accessibilityValue(...)` / `.accessibilityAddTraits(...)`.
- Decorative icons set `.accessibilityHidden(true)` (already done in `OrpheusIcon`).

## Comments

Default to writing none. Add a one-liner only when the WHY isn't obvious — a non-trivial invariant, a workaround, or a load-bearing constraint that would surprise a reader. No multi-paragraph docstrings.

## Reference components

- `Components/OrpheusText.swift` — minimal token-bound view (the simplest pattern).
- `Components/OrpheusSpinner.swift` — animated component, motion-token usage.
- `Components/OrpheusButton.swift` — full variant × size × state matrix, hover + press tracking, all tokens.

These three demonstrate every pattern other components should mirror.
