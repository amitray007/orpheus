# Orpheus — Design Principles

**Status:** Locked 2026-04-18 (session `2026-04-18-HHmm-decide-architecture-native-stack.md`)
**Supersedes:** none (first design lock)
**Companion spec:** `docs/specs/architecture.md` (the rendering stack and design-system layer)

---

## Philosophy

**Every visual decision in Orpheus is intentional.** Nothing is framework-forced. Nothing is a stock SwiftUI default. The app feels custom because every token — typography, color, spacing, material, motion, iconography — was chosen by us, not by Apple's HIG defaults.

This isn't a style preference. It's an identity commitment. Orpheus competes with Cursor, Raycast, Ghostty, cmux for the daily-driver attention of a taste-sensitive developer. Generic Mac-default aesthetic loses that fight every time.

**What "custom" means in practice:**
- Custom typeface pair (branded sans + branded mono) — not SF Pro
- Custom color palette with warm undertones — not Apple's neutral grays
- Custom materials tuned by hand — not stock `NSVisualEffectView` presets
- Custom iconography — SF Symbols treated with deliberate weight + color, or custom-drawn
- Custom components — never stock `Button`, `Toggle`, `TextField`, `List`, `Menu` in user-facing code
- Custom motion — spring presets we choose, not system defaults

**What "custom" does NOT mean:**
- Fighting macOS conventions. We live on macOS 26, embrace Liquid Glass where it fits, respect dark/light-mode expectations, honor accessibility defaults.
- Rejecting good defaults. If Apple's system animation timing feels right in context, we can adopt it — but deliberately, not by accident.
- Over-decoration. Custom ≠ ornamental. Cursor and Raycast are restrained; so is Orpheus.

---

## Reference aesthetics (study, don't copy)

| App | Stack | What to learn |
|---|---|---|
| **[Raycast](https://www.raycast.com/)** | SwiftUI + AppKit | The closest native aesthetic target. Dense rows, custom typography, tuned materials, tight spacing, distinctive command-bar/launcher pattern. |
| **[Ghostty](https://ghostty.org/)** | Swift + AppKit + libghostty | libghostty in a native shell. Window chrome, tab strip, split handling, preferences UI. |
| **[Cursor 3](https://cursor.com/blog/cursor-3)** | Electron (not native) | Agent-centric sidebar layout, unified multi-file diffs, inline Apply buttons, smooth streaming tokens. Aesthetic reference only; don't inherit the stack. |
| **Apple [Liquid Glass](https://developer.apple.com/documentation/TechnologyOverviews/liquid-glass)** | macOS 26 material language | Translucent depth, environmental refraction, fluid spring motion. Adopt where it fits; don't over-apply. |
| **[Things 3](https://culturedcode.com/things/)** | AppKit | Minimalist density, distinctive typography, fine-grained custom controls. |
| **[Arc Browser](https://arc.net/)** | Swift + AppKit | Heavy custom chrome — vertical sidebar, Spaces concept, reimagined window structure. |
| **[Ivory](https://tapbots.com/ivory/)** | SwiftUI | Timeline rendering, custom theming, gesture-rich interactions. |
| **cmux** | SwiftUI + AppKit | The thing we're replacing. Know it cold. |

**Cursor's design system in detail** (from [Kimera's case study](https://the-brandidentity.com/project/how-kimera-built-cursors-identity-around-a-custom-typeface-system)):
- **Custom typeface family** — "Cursor Mono" (code) + branded sans (UI, brand, marketing). A cohesive system that bridges app and brand.
- **Warm undertone** across all colors — subtle warm tint, not neutral gray.
- **Orange accent with provenance** — derived from power tools observed during design research. Accents feel intentional when they have a story.
- **Logo ligatures built into the font** — logotypes recreated inside the typeface, perfectly aligned with running text.
- **Performance as a feature** — 87% fewer dropped frames on large-file diff streaming; polish at the technical level.

**Takeaway for Orpheus:** we commission or curate a typeface system that speaks one language across app and brand. Our accent gets a provenance story. Performance is part of the aesthetic.

---

## Typography

### Requirements

- One branded sans-serif for UI chrome
- One branded monospace for terminal and code
- 6-step type ramp with consistent scale ratio
- Ligature-aware monospace
- Legible at small sizes (UI density requires this)
- OpenType features enabled (tabular numbers, stylistic alternates)

### Type ramp (tokens)

| Token | Size / Line-height | Weight | Use |
|---|---|---|---|
| `display` | 32 / 40 | semibold | hero / large hero dashboards |
| `title` | 22 / 28 | semibold | section titles |
| `heading` | 17 / 24 | semibold | sub-section titles, emphasized rows |
| `body` | 13 / 18 | regular | default UI text |
| `caption` | 11 / 14 | medium | metadata, badges |
| `mono` | 13 / 18 | regular | code, terminal |

(Sizes + line-heights to tune once final typefaces are selected.)

### Typeface candidates (to evaluate, not locked)

**Sans-serif (UI chrome):**
- **Inter** (variable, dense-friendly, widely trusted) — safe default
- **Geist Sans** (Vercel's, modern, tight) — trendy but clean
- **Satoshi** (geometric sans, has character) — distinctive
- **Söhne** (if budget allows — Linear uses this) — premium feel
- **Supreme** (geometric with humanist touches) — under-used, distinctive
- **Commit Mono's sister** — unexplored

**Monospace (terminal + code):**
- **JetBrains Mono** (ligature-rich, popular, free) — safe default
- **Geist Mono** (Vercel's, crisp) — trendy
- **Berkeley Mono** (premium, distinctive, paid) — high-end
- **Cartograph** (character-rich, ligature-aware, paid) — designer-favorite
- **Commit Mono** (minimalist, tight) — clean

### LOCKED v0: Satoshi + Commit Mono

**Sans:** **Satoshi** — geometric with humanist warmth, distinctive, not overused in tech. Commercial license (~$40–$75 one-time for full family).
**Mono:** **Commit Mono** — minimalist, warm, ligature-capable, free.

**Rationale:** Distinctive without premium price. Fits the warm-undertone direction. Underused in the current wave of dev tools so Orpheus stands out. Safer-feeling alternatives (Inter, JetBrains Mono) were rejected as too generic; premium alternatives (Söhne, Berkeley Mono) deferred as optional upgrades if a v1+ identity refresh wants them.

**Upgrade path:** commissioned-custom typeface pair considered for v2+ (see Kimera's work on Cursor as a reference for how a custom system can elevate brand + product).

### Discipline rules
- Use `OrpheusDesign.Typography.<token>` — never `Font.system(size:)` in user-facing code.
- Respect the type ramp. No off-ramp custom sizes unless explicitly added as a new token.
- Enable tabular numbers on everything numeric (usage charts, timers, counts).

---

## Color palette

### Philosophy

- **Warm-toned neutral scale** — not Apple's cool grays. A subtle ochre or warm undertone across the neutral ramp humanizes the app.
- **Distinctive accent with provenance** — our own story, not imitation. (Open: needs to be chosen.)
- **Semantic tokens over raw colors** — `surface`, `text-primary`, `accent`, etc. Never `Color.blue`.
- **Dark mode is primary** — Orpheus is a developer daily-driver; most users will live in dark. Light mode is first-class but polished second.
- **Liquid Glass compatibility** — tokens compose with glass materials (tints, highlights).

### Semantic token structure (initial)

**Surfaces** (lowest to highest elevation):
- `surface.base` — window background
- `surface.raised` — sidebars, cards
- `surface.elevated` — modals, overlays, command palette
- `surface.overlay` — tooltips, menus
- `surface.glass.light` — translucent glass tint (light-mode)
- `surface.glass.dark` — translucent glass tint (dark-mode)

**Text:**
- `text.primary` — default content
- `text.secondary` — labels, less-prominent info
- `text.tertiary` — metadata, timestamps
- `text.disabled`
- `text.inverted` — text on accent-colored backgrounds

**Accent — LOCKED v0: Lyre Gold**
- Provenance story: *"the color of Orpheus's lyre — the instrument that could charm gods, beasts, and even death itself."* Ties the codename directly to the accent. No adjacent dev tool owns this color (Cursor=orange, Raycast=coral-red, Linear=purple, VS Code=blue, GitHub=green, Anthropic=terracotta).
- Applied sparingly (~5% of visible pixels) — neutrals dominate, accent punctuates. Lives in: focus rings, active session indicators, menubar live-status pulse, logotype, selection tint overlays. NOT used for backgrounds, main text, surfaces.
- `accent.primary` — `#D9A441` (main gold)
- `accent.hover` — `#E6B04E` (slightly brighter)
- `accent.pressed` — `#BE8F35` (slightly dulled)
- `accent.subtle` — `#D9A441` at 12% opacity (tint backgrounds, hover rows, selection)

**Semantic:**
- `semantic.success`
- `semantic.warning`
- `semantic.critical`
- `semantic.info`

**Terminal / code:**
- Separate palette namespace for terminal ANSI colors — tuned for readability at a range of font sizes, dark + light themes.
- Separate palette for code syntax highlighting — aligned with accent but distinct.

### Dark + light mode
Both required. Dark-mode is primary focus. Tokens swap cleanly via SwiftUI's environment.

### LOCKED v0 dark-mode starter values

Direction: **warm-subtle** — Cursor-like neutral-dominant structure with a small warm shift (R > G > B by a few units across neutrals). Tuning during Phase 0 against real UI is expected.

**Surfaces (from deepest to most elevated):**
```
surface.base       #16130F   ← window background
surface.raised     #1E1A16   ← sidebars, cards
surface.elevated   #28231D   ← modals, overlays
surface.overlay    #332D26   ← tooltips, popovers
```

**Text (warm off-whites, not pure):**
```
text.primary       #F5EFE6   ← default content
text.secondary     #A89F92   ← labels, less-prominent
text.tertiary      #6B6358   ← metadata, timestamps
text.disabled      #4A453F
text.inverted      #1A1814   ← text on gold accent
```

**Borders / dividers:**
```
border.subtle      #2C2723   ← hairline
border.default     #3A352E   ← section boundaries
border.strong      #4D4741   ← emphasized outlines
```

**Accent (Lyre Gold family — see above):**
```
accent.primary     #D9A441
accent.hover       #E6B04E
accent.pressed     #BE8F35
accent.subtle      #D9A441 at 12% opacity
```

**Semantic (desaturated for dark; distinct hues for colorblind readability):**
```
semantic.success   #6FA378   ← warm-leaning green
semantic.warning   #D89E5C   ← amber (distinct hue from accent gold)
semantic.critical  #C96A5F   ← warm red, not pure
semantic.info      #7899B0   ← muted blue-gray
```

**Glass tokens (Liquid Glass materials):**
```
glass.tint         #241F1A at 50% opacity   ← warm dark tint behind blur
glass.highlight    #FFFFFF at 6% opacity    ← subtle white rim for elevated glass
```

**Tuning notes:**
- Warning (`#D89E5C`) is intentionally shifted hue-wards from accent gold (`#D9A441`) to avoid confusion at a glance; retune if they read too similarly.
- All semantic colors desaturated so status indicators don't scream on a daily-driver surface.
- `accent.subtle` is the token for hover-row tints and selection highlights — never use `accent.primary` opacity directly.

**Terminal ANSI + code syntax-highlighting palettes:** separate token namespaces, locked in Phase 2 and Phase 5 respectively (per `docs/plan.md`).

### LOCKED v0 light-mode starter values

Same semantic tokens, inverted for light backgrounds. Accent and semantic hues shifted darker/richer to maintain contrast on near-white surfaces.

**Surfaces (base = lightest; layers add subtle warm depth):**
```
surface.base       #FAF7F2   ← warm off-white (main background)
surface.raised     #F2ECE3   ← sidebars, cards
surface.elevated   #E8DFD2   ← modals, overlays
surface.overlay    #D9CFC0   ← tooltips, popovers
```

**Text (warm near-black, not pure):**
```
text.primary       #1A1815
text.secondary     #5C554B
text.tertiary      #8A8175
text.disabled      #B0A899
text.inverted      #FAF7F2   ← text on gold accent
```

**Borders (more visible on light than dark):**
```
border.subtle      #E5DED1
border.default     #CFC5B3
border.strong      #A89F8B
```

**Accent (Lyre Gold family — shifted darker for light-mode contrast):**
```
accent.primary     #B88A2E   ← richer gold for contrast on light
accent.hover       #C99937
accent.pressed     #9E7625
accent.subtle      #B88A2E at 10% opacity
```

**Semantic (deeper for light-contrast):**
```
semantic.success   #4A7A56
semantic.warning   #B57A2D
semantic.critical  #A04A3F
semantic.info      #4C7590
```

**Glass tokens (inverted):**
```
glass.tint         #F2ECE3 at 60% opacity
glass.highlight    #FFFFFF at 40% opacity
```

**Tuning notes:**
- `surface.base` at `#FAF7F2` vs. pure white — warm off-white is what GitHub Light and Rosé Pine Dawn use; bright enough to read as "white" but not sterile.
- Accent shifts from `#D9A441` (dark) to `#B88A2E` (light) — gold on light has to be richer/darker to keep visual weight and AA+ contrast.
- Semantic colors deeper across the board because lighter semantic values look washed on light surfaces.

### LOCKED v0 material tuning starter values

Four custom glass materials, each composing atop macOS 26's Liquid Glass system. Starter values — expect 2–3 rounds of visual iteration against real UI during Phase 0.

```
material.sidebar         ← left panel (projects/sessions hierarchy)
    blur-radius:        20 pt      (moderate — content behind subtly visible)
    tint-opacity:       50% dark / 60% light
    saturation-boost:   120%       (warmth amplification)
    rim-lighting:       none       (baseline glass, not elevated)

material.palette         ← ⌘K command palette, modal overlay
    blur-radius:        40 pt      (heavier — "floating above")
    tint-opacity:       70% dark / 75% light
    saturation-boost:   115%
    rim-lighting:       glass.highlight at 1.5 pt inner stroke  (elevated feel)

material.toolbar         ← top chrome, overlaying content where present
    blur-radius:        15 pt      (lighter — feels connected to content)
    tint-opacity:       40% dark / 50% light
    saturation-boost:   110%
    rim-lighting:       bottom edge only, glass.highlight at 1 pt
                        (subtle content separator)

material.overlay         ← modals, sheets, tooltips, popovers
    blur-radius:        30 pt      (clear separation from content below)
    tint-opacity:       65% dark / 70% light
    saturation-boost:   115%
    rim-lighting:       full border, glass.highlight at 1 pt
```

**Design logic:**
- **Blur-radius ladder** (15 → 20 → 30 → 40 pt): toolbar lightest (reads "part of content"), sidebar moderate (structural), overlay heavier (modal feel), palette heaviest (floating, ceremonial).
- **Tint opacity stronger on light mode** — light backgrounds benefit from more coverage to keep glass from disappearing.
- **Saturation boost** (110–120%) creates the characteristic Liquid Glass "content alive through the glass" effect. Sidebar strongest because seen most.
- **Rim lighting** only on elevated surfaces (palette, overlay) to reinforce layering. Toolbar gets subtle bottom-edge rim as separator. Sidebar gets none (co-equal with main content).

**Known tuning risks surfacing during Phase 0:**
- Sidebar saturation-boost possibly too strong → backgrounds read too colorful
- Palette blur-radius possibly too heavy → feels slow rather than instant
- Toolbar tint-opacity possibly too low → might not read as glass at all
- Overlay rim-lighting possibly too bright → gaudy dialog border effect

### Discipline rules
- Never use raw hex values in UI code — always through `OrpheusDesign.Colors`.
- Never use `Color.accentColor` (system default) — always through semantic tokens.
- All color tokens have explicit dark + light values.

---

## Materials

macOS 26's Liquid Glass is the native material language. Orpheus uses it selectively — not everywhere.

### Where glass fits
- **Sidebar** — translucent with subtle refraction. Content behind peeks through for spatial awareness.
- **Menubar** — full glass. Native treatment.
- **Command palette** — elevated glass overlay.
- **Tab strip** — subtle glass so underlying terminal color bleeds through.
- **Toolbar** — glass where overlaying content; opaque where framing content.

### Where glass doesn't fit
- **Terminal surface** — solid color. Content legibility is paramount; no translucency.
- **Code / diff / chat viewer bodies** — solid. Reading surfaces stay opaque.
- **Dashboards / heatmaps** — solid; data clarity first.

### Custom material tokens
Beyond stock `.regularMaterial`, `.thinMaterial`, etc. — we tune materials ourselves:
- `material.sidebar` — custom blur radius + tint
- `material.palette` — elevated glass for command palette
- `material.toolbar` — top-chrome material
- `material.overlay` — modals / sheets

Custom materials are defined as `OrpheusDesign.Materials.<token>` and compose with `VisualEffectView` under the hood.

### Liquid Glass specifics
- **Refraction** — use sparingly; content behind should be recognizable, not warped.
- **Rim lighting** — subtle; only on elevated surfaces (palette, modals).
- **Cursor-reactive highlights** — consider for premium touches (sidebar rows on hover); don't overdo.
- **Depth layering** — consistent elevation order (base < raised < elevated < overlay).

---

## Motion

### Philosophy
- **Spring-based, interruptible** — match macOS 26's fluid motion language.
- **No linear easings** in user-facing motion (keyboard/pointer interactions).
- **120 Hz ProMotion target** — animations must feel smooth on M-series Macs.
- **Purpose before polish** — every motion expresses a state change; no decoration-only motion.

### Motion tokens (initial)

| Token | Spring response | Damping | Use |
|---|---|---|---|
| `motion.quick` | 0.2 | 0.9 | small UI states (hover, press) |
| `motion.standard` | 0.3 | 0.8 | most transitions (open/close, pane changes) |
| `motion.settle` | 0.4 | 0.7 | layout rearrangement (splits, tab drags) |
| `motion.dramatic` | 0.5 | 0.65 | command palette entrance, modal presentations |

(Exact values to refine during build.)

### Discipline rules
- Every animation uses `OrpheusDesign.Motion.<token>`.
- Animations can always be interrupted; state remains coherent mid-animation.
- Terminal scroll is NOT animated (native terminal behavior dominates).
- Token streaming in chat viewer IS smoothly rendered (no flicker; characters appear rhythmically).

---

## Iconography

### Philosophy
- **Curated, not default.** Every icon chosen with intent.
- **Consistent weight** across an icon set (e.g. all regular, or all medium).
- **Deliberate color** — never default SF Symbol tint. Icons use semantic color tokens.
- **Custom-drawn where SF Symbols fall short** — Orpheus-specific concepts (project, space, tab, terminal, fork-pane, self-drive).

### SF Symbol treatment rules
- Pick one weight (likely `.medium`) as default across the app
- Pair with one size scale (tokens: `icon.small = 14`, `icon.medium = 16`, `icon.large = 20`, `icon.xlarge = 24`)
- Always specify color (`OrpheusDesign.Colors.<token>`)
- Use SF Symbol variants (fill, slash, etc.) with purpose — active/inactive, allowed/blocked states

### Custom icons (required)
- Orpheus logotype + logomark
- "Space" icon (distinct from generic folder)
- "Tab" icon (distinct from browser-style tab)
- "Terminal" icon (distinctive, not SF Symbol default)
- "Fork-to-pane" icon (split arrow with fork semantics)
- "Self-drive" indicator (when Claude is driving the UI)

### Icon catalog file
Maintained in `OrpheusDesign.Icons` — every icon referenced by token name, never by SF Symbol string directly.

---

## Layout and spacing

### Base unit
4 px. Everything measured in multiples.

### Spacing scale (tokens)
`spacing.0 = 0`, `spacing.1 = 4`, `spacing.2 = 8`, `spacing.3 = 12`, `spacing.4 = 16`, `spacing.5 = 24`, `spacing.6 = 32`, `spacing.7 = 48`, `spacing.8 = 64`

### Density rules
- **Tighter than SwiftUI defaults.** Stock SwiftUI list rows are ~44px; Orpheus rows are 28–32px.
- **4px baseline rhythm** — all vertical placement snaps to multiples of 4.
- **Information-dense without claustrophobic** — use subtle dividers and material layering to separate dense sections.

### Radius scale (tokens)
`radius.0 = 0`, `radius.1 = 4` (small chips), `radius.2 = 6` (buttons), `radius.3 = 8` (cards), `radius.4 = 12` (modals), `radius.full` (pill).

### Grid
- Window minimum: 800 × 600
- Sidebar default: 240 px wide, resizable
- Code viewer default: 40% of window width, resizable
- Terminal: fills remaining space

---

## Component catalog (to build in `OrpheusDesign`)

### Core set (v0 blockers — built in design-system phase)
- `OrpheusButton` — variants: `primary`, `secondary`, `ghost`, `destructive`. Sizes: `sm`, `md`, `lg`.
- `OrpheusToggle` — switch-style
- `OrpheusTextField` — single-line input, with optional leading/trailing content
- `OrpheusTextArea` — multi-line input with auto-grow
- `OrpheusList` + `OrpheusRow` — dense list pattern, supports selection, disclosure, badges
- `OrpheusMenu` — dropdown menu with keyboard nav
- `OrpheusSplitView` — custom splitter with drag resize + collapse
- `OrpheusTabBar` — custom tab strip with drag-reorder
- `OrpheusSidebar` — project/space/session hierarchy rendering
- `OrpheusCommandPalette` — fuzzy-search modal overlay
- `OrpheusQuickAction` — dynamic context-aware button/pill
- `OrpheusStatusBadge` — semantic color + icon + label
- `OrpheusTooltip` — custom styled hover info
- `OrpheusModal` + `OrpheusSheet` — presentation primitives

### Rich content (built as feature-surfaces reach them)
- `OrpheusMarkdownView` — `AttributedString`-based markdown rendering
- `OrpheusCodeView` — TextKit 2 + `SwiftTreeSitter` highlighter
- `OrpheusDiffView` — TextKit 2 + custom gutter + line highlighting
- `OrpheusChart` — Swift Charts wrapper with token styling
- `OrpheusHeatmap` — custom `Canvas` drawing, GitHub-style grid
- `OrpheusTerminalView` — libghostty wrapper (lives in `OrpheusTerminal` package but styled via tokens)

### Motion + feedback
- `OrpheusSpinner`
- `OrpheusProgressBar`
- `OrpheusSkeleton` (loading placeholder)
- `OrpheusToast` (transient notification)

---

## Discipline rules (the binding ones)

1. **Never use stock SwiftUI controls in user-facing code.** `Button {}`, `Toggle`, `TextField`, `List`, `Menu` are forbidden — always `OrpheusButton`, `OrpheusToggle`, etc.
2. **Never import raw hex colors.** All colors through `OrpheusDesign.Colors`.
3. **Never use raw pixel values for spacing.** All spacing through `OrpheusDesign.Spacing`.
4. **Never use system font.** All typography through `OrpheusDesign.Typography`.
5. **Never use default SF Symbol color or weight.** Always specify token.
6. **Every animation uses `OrpheusDesign.Motion.<token>`.** Documented exceptions only.
7. **Every icon referenced by token name,** not SF Symbol string or asset name directly.
8. **No web-stack escape hatches.** Native is the only rendering path in v0.

PR reviews reject violations.

---

## Open design decisions (to resolve in dedicated design sessions)

- [x] **Final typeface pair** — LOCKED: Satoshi + Commit Mono
- [x] **Final accent color + provenance story** — LOCKED: Lyre Gold with the Orpheus's-lyre story
- [x] **Dark-mode palette exact values** — LOCKED at v0 starter values (see section above)
- [x] **Light-mode palette exact values** — LOCKED at v0 starter values (see section above)
- [x] **Material tuning** — LOCKED at v0 starter values (see section above); Phase 0 tunes against real UI
- [ ] **Logotype + logomark design** — deferred to Phase 7 Polish
- [ ] **Icon catalog shape** — Phase 0 defines structure; Phase 7 finalizes full catalog
- [ ] **Terminal color scheme** — locked in Phase 2 (see `docs/plan.md`)
- [ ] **Code syntax highlighting theme** — locked in Phase 5 (see `docs/plan.md`)
- [ ] **Theme customizability** — support user-defined themes (accent + palette) as a v1+ feature per user request

---

## Process

### Phase 0 — design-system-first
Before any user-facing feature ships, `OrpheusDesign` exists with:
- Complete token set (typography, colors, spacing, radii, materials, motion)
- Core component set (Button, Toggle, TextField, List, Sidebar, CommandPalette, SplitView, TabBar, StatusBadge, Tooltip, Modal, Sheet)
- Icon catalog stub
- Storybook-equivalent preview gallery (probably `#Preview` blocks across components)

Estimate: 2–4 weeks of focused work before feature velocity begins.

### Phase 1+ — feature surfaces
Each new feature surface composes existing `OrpheusDesign` primitives. If a surface requires a new primitive, it's added to `OrpheusDesign` first (never ad-hoc in feature code).

### Reference discipline
Before building each surface, review the closest reference (Raycast / Ghostty / Cursor / Things / Arc) and note what works, what doesn't, what Orpheus does differently.

### PR review rule
Every PR touching UI goes through a design-discipline check: stock-component usage flagged, token violations rejected, motion-spec adherence required.

---

## Escape hatches (documented but not planned)

- **Syntax highlighter WKWebView fallback** — only if TextKit 2 + SwiftTreeSitter hits an unresolvable wall.
- **Premium paid typeface** — if free candidates can't achieve the aesthetic.
- **Commissioned custom typeface** — v2+ consideration for full brand-typography alignment (like Kimera did for Cursor).

---

## Related specs

- `docs/specs/architecture.md` — the full stack this design lives inside
- `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-04-17-0351-brainstorm-product-scope-foundation.md` — product scope + foundation that justifies this design commitment
