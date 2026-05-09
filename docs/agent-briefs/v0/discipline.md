# Phase 0 — Discipline rules + common pitfalls

These rules come directly from `docs/specs/design-principles.md` and are the non-negotiable constraints. They exist to make Orpheus distinctive; softening them at v0 compounds into mediocre UI.

## Hard rules

### 1. Never use stock SwiftUI controls
Every `Button`, `Toggle`, `TextField`, `List`, `Menu`, etc. in Orpheus goes through a custom `OrpheusDesign` component. If you find yourself writing `Button("Click") { ... }` or `Toggle("On", isOn: ...)` in a component file, stop — build the `OrpheusButton` / `OrpheusToggle` first, then use it.
- Applies to **default appearance**. You can use `Button` **internally** as a tap-handler primitive inside `OrpheusButton`, as long as nothing of SwiftUI's default button chrome is visible.
- Same for `Toggle`, `TextField`, etc.

### 2. Every color goes through a semantic token
No raw hex literals outside `Sources/OrpheusDesign/Tokens/Colors.swift`. No `.white`, `.black`, `.blue` elsewhere. If you need a color that doesn't exist in the token set, it's a spec gap — raise it in handoff, don't invent.

### 3. Every font goes through `OrpheusText` or the typography tokens
No `.font(.system(...))` outside `Sources/OrpheusDesign/Tokens/Typography.swift`. No bare `Text("...")` rendered with default font. Either wrap in `OrpheusText` (if you build it as a component) or apply an `OrpheusDesign` font modifier.

### 4. Every material goes through `OrpheusMaterial` tokens
No `.background(.ultraThinMaterial)` or `.regularMaterial` directly. The four tuned materials (`sidebar`, `palette`, `toolbar`, `overlay`) cover every surface type; if a new material is needed, it's a spec gap.

### 5. Every icon goes through `OrpheusIcon`
Even for SF Symbols, wrap via `OrpheusIcon(systemName: "...")`. Lets us swap to custom-drawn glyphs in Phase 7 without touching every call site.

### 6. Preview every component
Each component file has at least one `#Preview` covering the main states (idle / hover / pressed / disabled / loading — whichever apply). Dark + light both. Aim for one preview per major variant, not a single catch-all.

### 7. Dark-mode primary
When you make a trade-off (e.g., which of two hex values to tune more carefully), favor the dark-mode rendering. Light mode must work, but dark is the user's default daily driver.

### 8. Accessibility is a constraint, not a feature
- WCAG AA contrast (4.5:1 body / 3:1 large) verified by tests, not eyeballed.
- All interactive elements reachable via keyboard; focus ring visible (custom, not system default).
- `VoiceOver` labels on every interactive component.
- Respect `NSAccessibility.reduceMotion` — substitute instant transitions when set.

## Architectural discipline

### No stock SwiftUI containers beyond basic layout primitives
- `VStack`, `HStack`, `ZStack`, `LazyVStack`, `LazyHStack`, `Grid`, `ScrollView`, `Spacer` — fine.
- `List`, `Form`, `NavigationStack`, `NavigationSplitView`, `Tab*` — NOT fine without a custom wrapper.

### No stock SwiftUI state-styling modifiers that imply system chrome
- `.buttonStyle(.borderedProminent)` — NOT fine.
- `.textFieldStyle(.roundedBorder)` — NOT fine.
- `.toggleStyle(.switch)` — NOT fine (even though the goal is a switch-like toggle; build it ourselves).

### Layered composition
Components compose like this: `OrpheusButton` internally uses primitives (ZStack, tap gesture, hover tracking, animation), styled via tokens. It does **not** import another high-level component as its backing (e.g., don't build `OrpheusSidebar` on top of NavigationSplitView).

## Common pitfalls

### Liquid Glass materials on untransparent windows
Liquid Glass needs a transparent surface above it to see through. If you test a material on a solid window, it'll look flat. Make sure the preview / catalog app has a transparent NSWindow (set `isOpaque = false`, `backgroundColor = .clear`).

### Satoshi font embedding
Satoshi is licensed by Indian Type Foundry / Fontshare — **verify license terms allow embedding in a closed-source Mac app** before committing the font files. If not, swap to a similar sans-serif (Inter, General Sans) and raise the swap in handoff.
- Commit Mono is OFL — free to embed.
- Embedded fonts go in `Sources/OrpheusDesign/Resources/Fonts/` and are registered via `CTFontManagerRegisterFontsForURL` at package initialization.

### Hover tracking on macOS
SwiftUI's `.onHover` works but the hover state must be wired into the component's appearance model (not just visual). Use `@State private var isHovered: Bool` and token-driven color/opacity changes.

### Focus ring customization
macOS's default focus ring is aggressive blue. Suppress with `.focused(...)` binding + custom overlay. Don't rely on system appearance.

### Preview compilation speed
If component previews get slow to compile, split providers. Don't fold 10 variants into one preview.

### macOS 26 vs older macOS
Liquid Glass API is macOS 26+. Use `@available` guards and provide a sane fallback (e.g., matte colored surfaces) for older targets if the architecture spec requires back-deployment. Check `architecture.md`.

## When to break a rule

Never, in Phase 0. If a rule genuinely blocks you, it's a spec gap or an architecture question — stop, flag in handoff, wait for resolution. Phase 0 is the one phase where bending rules compounds the worst, because every downstream phase inherits from what you build here.
