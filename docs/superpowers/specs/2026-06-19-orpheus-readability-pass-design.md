# Orpheus Readability Pass — Typography + Color Grading

- **Date:** 2026-06-19
- **Status:** Approved (design); pending implementation plan
- **Scope:** App chrome only (renderer). Terminal font/colors (ghostty) untouched.
- **Context:** see `.impeccable.md` (audience, tone, brand colors)

## Problem

Two maintainer-reported readability complaints:

1. **"The font is too small / not very readable at times."**
2. **"Some texts are too light in some themes — not visually visible. Want the color
   grading on point too."**

## Root-cause diagnosis

**Typography**

- The entire UI renders in **Geist Pixel** (a pixel/bitmap _display_ font) for both
  `--font-sans` and `--font-mono` (`src/renderer/src/assets/main.css:48-50`). Pixel
  fonts lose legibility at UI sizes — this is the primary cause of (1), more than size.
- **No type system.** Sizes are ad-hoc: `text-[9px]`, `text-[10px]`, `text-[11px]`
  mixed with `text-xs/sm/base`. Per the typography reference, too many close sizes =
  muddy hierarchy. The existing font-scale setting (`small/default/large` → 12/14/16px
  root) does **not** affect arbitrary-px values, so the tiniest text never scales.
- Body is 14px (`main.css:168`); no `tabular-nums`; no metric-matched fallback (FOUT
  layout shift on font swap).

**Color**

Computed WCAG contrast of `text-muted` against `surface-base`:

| Theme    | `text-muted` | bg (`surface-base`) | ratio  | AA (4.5:1)? |
| -------- | ------------ | ------------------- | ------ | ----------- |
| Midnight | `#71717a`    | `#0b0b0c`           | 4.06:1 | ✗ fail      |
| Eclipse  | `#6b6b6b`    | `#000000`           | 3.92:1 | ✗ fail      |
| Daylight | `#8b8b8e`    | `#fafaf7`           | 3.25:1 | ✗ fail      |

`text-muted` fails AA in **all three themes**, and it is used heavily on 10–11px text
(which needs _more_ contrast). Compounding factors:

- **14 alpha-dimmed text usages** (`text-text-muted/60` ×10, `/70` ×3, `/50` ×1) stack
  opacity on already-failing muted. Alpha-on-text is a documented design smell
  (unpredictable contrast). Worst case: footer `text-[9px] … text-text-muted/60`.
- **6 raw `text-zinc-400`** spinner glyphs (TopBar, ActivityIndicator,
  OrpheusStatusSection) bypass theme tokens — on Daylight, `#a1a1aa` on near-white is
  ~2.3:1 (effectively invisible). A real per-theme bug.
- Neutrals are **cool zinc** (`#71717a` leans blue) while the default accent is **warm
  gold** — a subtle clash. But the accent is **user-selectable across the hue wheel**,
  so the fix is _accent-aware neutrals_, not a fixed warm tint.

## Locked decisions (from brainstorming)

| Decision        | Choice                                                              |
| --------------- | ------------------------------------------------------------------- |
| Approach        | **Hybrid** — clean body font + pixel accents                        |
| Body / mono     | **Geist Sans** (UI) + **Geist Mono** (code/data)                    |
| Pixel scope     | **Wordmark + section/page headers + short uppercase eyebrows** only |
| Contrast target | **WCAG AA floor (4.5:1 / 3:1 large), hierarchy preserved**          |
| Tone            | **Refined dark terminal**, must hold under all 5 accents            |
| Neutrals        | **Hue-neutral, AA-locked; accent is the only chroma carrier**       |

## Design

### Typography system

1. **Modular `rem` scale**, 5 semantic tokens — indicative px at the `default` scale:
   `--text-caption` 12 · `--text-secondary` 13 · `--text-body` **15** · `--text-subhead`
   18 · `--text-head` 22 (modular ~1.2 across the body→head range; tighter steps at the
   dense small tiers, which is correct for app metadata). Nothing functional below
   `--text-caption` (12px). **Delete every arbitrary `text-[Npx]`** and remap to a token.
   The existing `small/default/large` setting shifts the **whole** scale (≈ 13 / 15 / 17px
   body), replacing today's 12/14/16 root — so the readable floor holds at every setting
   and there are no more unscalable px holes. Hierarchy leans on **weight + color + space**,
   not size alone, so the small tiers can sit close without going muddy.
2. **Geist, one family / three roles**, self-hosted from the installed `geist@^1.7.0`
   package (matches the existing `GeistPixel-Square.woff2` self-host pattern):
   - `Geist-Variable.woff2` → **Geist Sans** → `--font-sans`
   - `GeistMono-Variable.woff2` → **Geist Mono** → `--font-mono`
   - `GeistPixel-Square.woff2` → **Geist Pixel** → new `--font-pixel`
     (Tailwind v4 auto-generates the `font-pixel` utility from the `--font-*` token).
     Weights limited to **400 / 500 / 600**.
3. **Variable weight by theme:** body ~400 in Daylight, **~350 in Midnight/Eclipse**
   (light-on-dark needs less weight) with line-height +0.05–0.1 on dark.
4. **Detail polish:** `font-variant-numeric: tabular-nums` on counts/versions/
   timestamps/token figures; **metric-matched fallback** `@font-face`
   (`size-adjust`/`ascent-override`/`descent-override`) to kill swap-in layout shift;
   `font-variant-ligatures: none` in code; uppercase eyebrows keep their tracking.
5. **Pixel application** (`font-pixel`, with a legible size floor ~11–12px so it never
   reintroduces the "too small"):
   - `Orpheus` wordmark — `src/renderer/src/App.tsx:55`
   - Section/page titles (settings `<h2>`s; page headers)
   - Short uppercase eyebrow labels — e.g. `SettingsView.tsx:364`,
     `WorkspacesView.tsx:211`, `ClaudeSubagentsSection.tsx:118` (`labelClass`)
     Everything else inherits Geist Sans. The ~50 existing `font-mono` spots (code,
     inputs, branch names, JSON, version strings, braille spinners) become Geist Mono.

### Color system — accent-aware, AA-locked

1. **Text tokens** (`--color-text-primary/-secondary/-muted`) re-expressed in **OKLCH**,
   **hue-neutral**, luminance-tuned to clear **≥4.5:1** (≥3:1 for genuinely large text)
   against the _hardest_ surface each lands on, in every theme. Hierarchy preserved:
   `primary > secondary > muted`. Indicative `text-muted` moves (finalized by the
   contrast pass): Midnight `#71717a`→ brighter; Eclipse `#6b6b6b`→ brighter; Daylight
   `#8b8b8e`→ **darker** (light theme: muted darkens to gain contrast). **No accent
   bleeds into text** → legibility guaranteed for all 5 accents.
2. **Accent is the only chroma carrier** (60-30-10 by visual weight): focus rings,
   selected/active states, links, the wordmark dot — applied consistently for whichever
   accent is active.
3. **Accent-aware surfaces (optional/approved taste call):** chrome surfaces and borders
   echo the _active_ accent via `color-mix(in oklch, var(--color-accent) ~5%, <neutral>)`
   so switching teal↔pink subtly re-tints the whole shell. Large areas, tiny mix,
   re-verified for contrast. Isolated commit, easy to revert.
4. **Kill the 14 alpha-dimmers** → solid `text-text-muted` (now the legible floor;
   nothing readable goes below it). **Tokenize the 6 raw `text-zinc-400`** → theme token
   (`text-text-secondary`) so they adapt (fixes Daylight invisibility). **Gray-on-chip**
   spots → tint toward the chip surface rather than flat gray.
5. **Eclipse softened (optional/approved taste call):** base `#000000`→`oklch(~13%)`,
   text `#ffffff`→ off-white, to reduce halation/eye-strain. Vetoable for pure-black OLED.

## Concrete change inventory

- `src/renderer/src/assets/main.css` — `@font-face` (×3 + fallback), `@theme` font +
  type-scale + neutral OKLCH tokens, per-theme blocks (`:root`/midnight/daylight/eclipse),
  accent-aware surface mix, body weight/line-height, eclipse softening.
- Copy `Geist-Variable.woff2` + `GeistMono-Variable.woff2` into
  `src/renderer/src/assets/fonts/`.
- `App.tsx:55` — wordmark → `font-pixel`.
- Component sweep (remap arbitrary px → scale tokens; apply `font-pixel` to headers/
  eyebrows; `tabular-nums` on numeric spots; replace `…/60|/70|/50` dimmers; replace
  `text-zinc-400`): TopBar, Sidebar, SettingsView, WorkspacesView, WorkspaceDrawer,
  WorkspaceTitleBar, ActivityIndicator, OrpheusStatusSection, OrpheusFooterSection,
  SplitButton, settings/primitives, settings/Claude*Section, settings/Orpheus*Section.

## Verification

- **Computational contrast pass:** compute OKLCH contrast for **every
  text-token × surface × theme × accent** combination; assert all clear AA (4.5:1, or
  3:1 where the consuming text is large). This is the "color grading on point" guarantee.
  One-off script/computation — not a committed test (repo has no test runner).
- **Build:** `bun run build:unpack` → `open /Applications/Orpheus.app` → spot-check the
  three themes under at least two accents (one warm, one cool). Sanity-check process per
  `CLAUDE.md`.

## Sequencing (commit-as-you-go, sonnet subagents where bulk)

1. **Fonts:** `@font-face` ×3 + metric fallback + woff2 copy + `--font-*` tokens +
   type-scale tokens.
2. **Color system:** OKLCH neutral retune (all themes), accent-aware surfaces,
   alpha-dimmer + raw-zinc sweep.
3. **Component application (bulk, parallelizable by directory):** remap px→scale, apply
   `font-pixel`, `tabular-nums`.
4. **Verify:** contrast pass + build + visual spot-check; eclipse/accent-surface taste
   calls as isolated commits.

## Out of scope

- Terminal font/colors (user's `~/.config/ghostty/config`).
- The existing Small/Default/Large font-scale setting (kept; now scales everything).
- Semantic amber/red warning colors (audited in the contrast pass; restyled only if
  they fail).
- Any new settings UI (this is a system-level retune, not a new control).
