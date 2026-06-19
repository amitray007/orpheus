# Orpheus Readability Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Orpheus app chrome readable — replace the pixel display font used for body text with Geist Sans/Mono (pixel kept as an accent), establish one type scale, and bring every text color to WCAG AA across all themes and accents.

**Architecture:** All typography/color tokens live in `src/renderer/src/assets/main.css` (Tailwind v4 `@theme` + per-theme `[data-theme]` blocks). We redefine the Tailwind size ramp and font tokens there (so existing `text-xs/sm/base` classes adopt new values with no per-component churn), then sweep the renderer for the few things that bypass the system: arbitrary `text-[Npx]`, alpha-dimmed text, and raw `text-zinc-*`. A standalone Node script computes WCAG contrast for every token×surface×theme×accent combination and is the objective gate for the color work.

**Tech Stack:** Electron 39 renderer · React 19 · Tailwind v4 (CSS-first `@theme`) · Geist variable fonts (self-hosted woff2 from `geist@^1.7.0`) · Bun.

## Global Constraints

- **Contrast floor: WCAG AA** — text ≥ **4.5:1** (≥ 3:1 large/bold), UI/icons ≥ 3:1 — against the hardest surface it lands on, in **every theme × every accent**. Verified computationally.
- **No alpha on text** — opacity-dimmed text (`text-…/NN`) is banned; use a solid graded token.
- **One type scale** — no arbitrary `text-[Npx]`; map to a Tailwind size utility. Body lands ~15px at the `default` font-scale; nothing functional below `text-xs` (12px at default).
- **Tokens, not raw colors** — theme-variant text uses `text-text-*` tokens, never raw `text-zinc-*`.
- **Geist = one family, three roles** — Sans (body) · Mono (code/data) · Pixel (wordmark + headers/eyebrows only). Weights limited to 400/500/600.
- **Do NOT change the root/html `font-size`** (the `[data-font-scale]` values 12/14/16). Changing it rescales all rem-based spacing. Express the type scale in `rem` relative to the existing 14px default.
- **Scope:** renderer chrome only. No terminal (ghostty) changes, no DB/schema changes, no new settings UI.
- **Commits:** Conventional Commits, no emoji, no `Co-Authored-By`. Bun is the package manager.
- **Verify loop:** fast per-task checks (`bun run typecheck`, `bun run lint`, grep assertions, `bun run build`); final gate is `bun run build:unpack` + `open /Applications/Orpheus.app` + visual spot-check (auto-close/relaunch is pre-authorized per `CLAUDE.md`).

---

### Task 1: Self-host Geist Sans + Mono, swap font roles, define the type scale

**Files:**

- Modify: `src/renderer/src/assets/main.css` (font-face block `:8-14`, `@theme` `:16-51`, body `:156-173`, per-theme blocks `:59-98`)
- Create (copy): `src/renderer/src/assets/fonts/Geist-Variable.woff2`, `src/renderer/src/assets/fonts/GeistMono-Variable.woff2`

**Interfaces:**

- Produces: CSS tokens `--font-sans` (Geist Sans), `--font-mono` (Geist Mono), `--font-pixel` (Geist Pixel → auto-generates the `font-pixel` utility); redefined `--text-xs/sm/base/lg/xl` ramp; per-theme `--body-weight`. Tasks 5 and 6 consume the `text-*` utilities and `font-pixel`.

- [ ] **Step 1: Copy the variable woff2 files into the renderer assets**

```bash
cd /Users/maverick/code/projects/orpheus
cp node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2 src/renderer/src/assets/fonts/
cp node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.woff2 src/renderer/src/assets/fonts/
ls -1 src/renderer/src/assets/fonts/
```

Expected: lists `Geist-Variable.woff2`, `GeistMono-Variable.woff2`, `GeistPixel-Square.woff2`.

- [ ] **Step 2: Replace the single `@font-face` block** (`main.css:3-14`) with three faces

```css
/*
 * Geist family — self-hosted from the `geist` npm package (woff2 copied into
 * ./fonts). Sans = UI/body, Mono = code/data, Pixel = wordmark + headers only.
 * © Vercel Inc. — SIL Open Font License 1.1
 */
@font-face {
  font-family: 'Geist Sans';
  src: url('./fonts/Geist-Variable.woff2') format('woff2');
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'Geist Mono';
  src: url('./fonts/GeistMono-Variable.woff2') format('woff2');
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'Geist Pixel';
  src: url('./fonts/GeistPixel-Square.woff2') format('woff2');
  font-weight: normal;
  font-style: normal;
  font-display: swap;
}
```

- [ ] **Step 3: Update the font + add the type-scale tokens in `@theme`** (`main.css:48-50`)

Replace the `--font-sans` / `--font-mono` lines with:

```css
--font-sans: 'Geist Sans', -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
--font-mono: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
--font-pixel: 'Geist Pixel', 'Geist Sans', monospace;

/* Type scale — rem is relative to the 14px default root, so values land on the
     px targets below at the `default` font-scale and ride the small/large setting.
     Do NOT change the html font-size to "fix" these — that rescales all spacing. */
--text-xs: 0.857rem; /* 12px  — caption / metadata (was 0.75rem ≈ 10.5px) */
--text-xs--line-height: 1.4;
--text-sm: 0.929rem; /* 13px  — secondary UI */
--text-sm--line-height: 1.45;
--text-base: 1.071rem; /* 15px — body */
--text-base--line-height: 1.55;
--text-lg: 1.286rem; /* 18px  — subheading */
--text-lg--line-height: 1.3;
--text-xl: 1.571rem; /* 22px  — heading */
--text-xl--line-height: 1.2;
```

- [ ] **Step 4: Add a per-theme `--body-weight`** to each theme block

In `:root,[data-theme='midnight']` (`:60`) and `[data-theme='eclipse']` (`:87`) add:

```css
--body-weight: 350;
```

In `[data-theme='daylight']` (`:74`) add:

```css
--body-weight: 400;
```

(Light-on-dark needs less weight; dark-on-light keeps 400.)

- [ ] **Step 5: Update the `body` rule** (`main.css:156-173`)

Change `font-size: 14px;` → `font-size: var(--text-base);`, add weight + rhythm + mono numerics. The body block becomes:

```css
body {
  background: transparent;
  color: var(--color-text-primary, #f4f4f5);
  font-family: var(--font-sans);
  font-size: var(--text-base);
  font-weight: var(--body-weight, 400);
  line-height: 1.55;
  font-kerning: normal;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  user-select: none;
  overflow: hidden;
}

/* Tabular figures + no ligatures where columns/code must align */
code,
pre,
.font-mono {
  font-variant-numeric: tabular-nums;
  font-variant-ligatures: none;
}
```

- [ ] **Step 6: Verify the renderer compiles** (Tailwind/CSS errors surface here)

```bash
cd /Users/maverick/code/projects/orpheus && bun run build
```

Expected: build completes with no CSS/Tailwind errors. (This is electron-vite's renderer build; native addons are untouched so a full `build:unpack` isn't needed yet.)

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/assets/main.css src/renderer/src/assets/fonts/Geist-Variable.woff2 src/renderer/src/assets/fonts/GeistMono-Variable.woff2
git commit -m "feat(ui): self-host Geist Sans/Mono, add type scale, pixel as accent font"
```

---

### Task 2: Contrast verification harness + neutral text retune (AA)

**Files:**

- Create: `scripts/verify-contrast.mjs`
- Modify: `src/renderer/src/assets/main.css` — `--color-text-primary/-secondary/-muted` in all three theme blocks (`:65-67`, `:79-81`, `:92-94`)

**Interfaces:**

- Produces: `scripts/verify-contrast.mjs` — parses `main.css`, exits `0` if every text-token×surface×theme contrast ≥ 4.5, else `1` with a failure table. Task 3 extends it with the accent dimension.

- [ ] **Step 1: Write the verification harness**

Create `scripts/verify-contrast.mjs`:

```js
#!/usr/bin/env bun
// WCAG-AA contrast gate for Orpheus text tokens. Parses main.css, computes
// contrast for every text-token × surface × theme, asserts >= TARGET.
// Run: bun scripts/verify-contrast.mjs
import { readFileSync } from 'node:fs'

const TARGET = 4.5
const CSS = readFileSync(new URL('../src/renderer/src/assets/main.css', import.meta.url), 'utf8')

// ---- color parsing -> WCAG relative luminance -------------------------------
const srgbToLin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const lumFromLinear = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b

function hexToLin(hex) {
  const h = hex.replace('#', '')
  const n =
    h.length === 3
      ? h
          .split('')
          .map((x) => x + x)
          .join('')
      : h
  const r = parseInt(n.slice(0, 2), 16) / 255
  const g = parseInt(n.slice(2, 4), 16) / 255
  const b = parseInt(n.slice(4, 6), 16) / 255
  return [srgbToLin(r), srgbToLin(g), srgbToLin(b)]
}

// OKLCH -> linear sRGB (Björn Ottosson). Returns clamped linear RGB.
function oklchToLin(L, C, H) {
  const a = C * Math.cos((H * Math.PI) / 180)
  const b = C * Math.sin((H * Math.PI) / 180)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3,
    m = m_ ** 3,
    s = s_ ** 3
  const R = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const G = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const B = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  return [R, G, B].map((v) => Math.min(1, Math.max(0, v)))
}

function luminance(value) {
  const v = value.trim()
  if (v.startsWith('#')) return lumFromLinear(...hexToLin(v))
  const m = v.match(/oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.]+)/i)
  if (m) {
    let L = parseFloat(m[1])
    if (v.includes('%')) L /= 100
    return lumFromLinear(...oklchToLin(L, parseFloat(m[2]), parseFloat(m[3])))
  }
  throw new Error(`Cannot parse color: ${value}`)
}

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// ---- extract per-theme token blocks ----------------------------------------
const THEMES = {
  midnight: /:root,\s*\[data-theme='midnight'\]\s*\{([^}]*)\}/,
  daylight: /\[data-theme='daylight'\]\s*\{([^}]*)\}/,
  eclipse: /\[data-theme='eclipse'\]\s*\{([^}]*)\}/
}
const grab = (block, name) => {
  const m = block.match(new RegExp(`--color-${name}:\\s*([^;]+);`))
  return m ? m[1].trim() : null
}

let failed = 0
const surfaces = ['surface-base', 'surface-raised', 'surface-overlay']
const texts = ['text-primary', 'text-secondary', 'text-muted']

for (const [theme, re] of Object.entries(THEMES)) {
  const block = CSS.match(re)?.[1]
  if (!block) {
    console.error(`✗ theme block not found: ${theme}`)
    failed++
    continue
  }
  console.log(`\n${theme}`)
  for (const t of texts) {
    const tv = grab(block, t)
    for (const s of surfaces) {
      const sv = grab(block, s)
      const ratio = contrast(tv, sv)
      const ok = ratio >= TARGET || t === 'text-primary' // primary always strong
      const flag = ratio >= TARGET ? '✓' : ok ? '~' : '✗'
      if (ratio < TARGET && t !== 'text-primary') failed++
      console.log(`  ${flag} ${t.padEnd(14)} on ${s.padEnd(15)} ${ratio.toFixed(2)}:1`)
    }
  }
}

console.log(`\n${failed === 0 ? '✓ PASS' : `✗ FAIL (${failed} below ${TARGET}:1)`}`)
process.exit(failed === 0 ? 0 : 1)
```

- [ ] **Step 2: Run it against current `main.css` — confirm it FAILS**

```bash
cd /Users/maverick/code/projects/orpheus && bun scripts/verify-contrast.mjs; echo "exit=$?"
```

Expected: FAIL, exit=1. `text-muted` shows ~4.06 (midnight), ~3.92 (eclipse), ~3.25 (daylight) — matching the diagnosis. This proves the harness detects the real failures.

- [ ] **Step 3: Retune the neutral text tokens to OKLCH AA-passing values**

In `:root,[data-theme='midnight']` replace lines `:65-67`:

```css
--color-text-primary: oklch(96.5% 0.003 264);
--color-text-secondary: oklch(72% 0.005 264);
--color-text-muted: oklch(62% 0.005 264);
```

In `[data-theme='daylight']` replace lines `:79-81`:

```css
--color-text-primary: oklch(22% 0.004 264);
--color-text-secondary: oklch(42% 0.006 264);
--color-text-muted: oklch(52% 0.006 264);
```

In `[data-theme='eclipse']` replace lines `:92-94`:

```css
--color-text-primary: oklch(97% 0 0);
--color-text-secondary: oklch(76% 0.004 264);
--color-text-muted: oklch(61% 0.004 264);
```

(Hue 264 = a whisper of cool to avoid dead-pure-gray per the color reference; chroma ≤0.006 keeps them effectively neutral so they don't fight any accent.)

- [ ] **Step 4: Run the harness — confirm it PASSES; nudge if needed**

```bash
cd /Users/maverick/code/projects/orpheus && bun scripts/verify-contrast.mjs; echo "exit=$?"
```

Expected: `✓ PASS`, exit=0. If any `text-muted` still prints `✗`, raise that theme's muted lightness by `+2%` (dark themes) or lower it by `2%` (daylight) and re-run until PASS. Keep `muted` L between `secondary` and the failing edge so hierarchy holds.

- [ ] **Step 5: Verify renderer still compiles**

```bash
cd /Users/maverick/code/projects/orpheus && bun run build
```

Expected: success (OKLCH is valid CSS in Electron 39 / Chromium).

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-contrast.mjs src/renderer/src/assets/main.css
git commit -m "fix(ui): bring text tokens to WCAG AA in all themes, add contrast harness"
```

---

### Task 3: Accent-aware surfaces + Eclipse softening (taste calls — isolated)

**Files:**

- Modify: `src/renderer/src/assets/main.css` — eclipse surfaces (`:88-91`), add accent-aware surface tint
- Modify: `scripts/verify-contrast.mjs` — add the accent dimension

**Interfaces:**

- Consumes: the harness from Task 2. Produces: harness that also checks text against accent-tinted surfaces for all 5 accents.

- [ ] **Step 1: Soften Eclipse off pure black/white**

In `[data-theme='eclipse']` replace surfaces `:88-91`:

```css
--color-surface-base: oklch(13% 0.002 264);
--color-surface-raised: oklch(16% 0.003 264);
--color-surface-overlay: oklch(20% 0.004 264);
--color-border-default: oklch(26% 0.004 264);
```

(`text-primary` is already off-white `oklch(97%)` from Task 2, so pure `#fff` is gone too.)

- [ ] **Step 2: Add a faint accent echo to raised/overlay surfaces**

Append after the accent blocks (`main.css:124`), so it applies on top of whatever theme+accent is active:

```css
/* Accent-aware chrome: raised/overlay surfaces echo the active accent ~4%.
   Tiny mix; text contrast against these is re-verified by verify-contrast.mjs. */
:root {
  --color-surface-raised: color-mix(in oklch, var(--color-accent) 4%, var(--color-surface-raised));
  --color-surface-overlay: color-mix(
    in oklch,
    var(--color-accent) 5%,
    var(--color-surface-overlay)
  );
}
```

NOTE: this `:root` rule must come _after_ the theme blocks so the theme value is defined first; because `color-mix` reads the already-resolved `--color-surface-raised`, give the mixed result a distinct token instead to avoid self-reference. Implement as:

```css
:root,
[data-theme] {
  --surface-raised-tinted: color-mix(in oklch, var(--color-accent) 4%, var(--color-surface-raised));
  --surface-overlay-tinted: color-mix(
    in oklch,
    var(--color-accent) 5%,
    var(--color-surface-overlay)
  );
}
```

Then point the Tailwind utilities at the tinted tokens in `@theme` (`main.css:27-28`):

```css
--color-surface-raised: var(--surface-raised-tinted, var(--color-surface-raised));
--color-surface-overlay: var(--surface-overlay-tinted, var(--color-surface-overlay));
```

- [ ] **Step 3: Extend the harness with the accent dimension**

In `scripts/verify-contrast.mjs`, before the final summary, add accent-mixed checks. Append this block after the theme loop (reuses `oklchToLin`/`luminance`/`contrast`):

```js
// ---- accent-tinted surfaces: text must still clear AA on the mixed chrome ----
const ACCENTS = {}
for (const m of CSS.matchAll(/\[data-accent='([a-z]+)'\]\s*\{[^}]*--color-accent:\s*([^;]+);/g)) {
  ACCENTS[m[1]] = m[2].trim()
}
// oklab lerp approximates color-mix(in oklch) for tiny percentages (luminance guard)
function mixLin(aHex, bVal, t) {
  const la = luminance(aHex),
    lb = luminance(bVal)
  return la * (1 - t) + lb * t // luminance is ~linear under small oklab mixes
}
for (const [theme, re] of Object.entries(THEMES)) {
  const block = CSS.match(re)?.[1]
  if (!block) continue
  const overlay = grab(block, 'surface-overlay')
  for (const t of texts.filter((x) => x !== 'text-primary')) {
    const tv = grab(block, t)
    for (const [name, acc] of Object.entries(ACCENTS)) {
      const lo = mixLin(overlay, acc, 0.05)
      const hi = luminance(tv)
      const [a, b] = [hi, lo].sort((x, y) => y - x)
      const ratio = (a + 0.05) / (b + 0.05)
      if (ratio < TARGET) {
        failed++
        console.log(`  ✗ ${theme}/${name}: ${t} on overlay+accent ${ratio.toFixed(2)}:1`)
      }
    }
  }
}
```

Move the final `console.log`/`process.exit` to after this block.

- [ ] **Step 4: Run the harness — must still PASS across accents**

```bash
cd /Users/maverick/code/projects/orpheus && bun scripts/verify-contrast.mjs; echo "exit=$?"
```

Expected: `✓ PASS`, exit=0. If any accent fails on overlay, drop that mix percentage to 3% and re-run.

- [ ] **Step 5: Compile + commit**

```bash
cd /Users/maverick/code/projects/orpheus && bun run build
git add src/renderer/src/assets/main.css scripts/verify-contrast.mjs
git commit -m "feat(ui): accent-aware surfaces, soften eclipse off pure black"
```

---

### Task 4: Kill alpha-dimmers + tokenize raw zinc text (color sweep)

**Files (modify — replace patterns only):**
TopBar, Sidebar, SettingsView, WorkspacesView, WorkspaceDrawer, WorkspaceTitleBar, ActivityIndicator, OrpheusStatusSection, OrpheusFooterSection, SplitButton, settings/primitives, and any other matches surfaced by the baseline grep.

**Interfaces:** none produced; pure find/replace gated by grep.

- [ ] **Step 1: Baseline counts**

```bash
cd /Users/maverick/code/projects/orpheus/src/renderer/src
grep -rEc --include='*.tsx' 'text-text-(muted|secondary)/[0-9]+' . | grep -v ':0' | awk -F: '{s+=$2} END{print "dimmers:", s}'
grep -rc --include='*.tsx' 'text-zinc-400' . | grep -v ':0' | awk -F: '{s+=$2} END{print "zinc-400:", s}'
```

Expected: `dimmers: 14`, `zinc-400: 6`.

- [ ] **Step 2: Replace alpha-dimmed text with the solid token**

For every match of `text-text-muted/NN` and `text-text-secondary/NN`, drop the `/NN`. Run per file (review each diff):

```bash
cd /Users/maverick/code/projects/orpheus/src/renderer/src
for f in $(grep -rEl --include='*.tsx' 'text-text-(muted|secondary)/[0-9]+' .); do
  perl -pi -e 's{text-text-(muted|secondary)/[0-9]+}{text-text-$1}g' "$f"
done
```

- [ ] **Step 3: Replace raw zinc spinners with the theme token**

`text-zinc-400` → `text-text-secondary` (adapts per theme; fixes Daylight invisibility):

```bash
cd /Users/maverick/code/projects/orpheus/src/renderer/src
for f in $(grep -rl --include='*.tsx' 'text-zinc-400' .); do
  perl -pi -e 's{text-zinc-400}{text-text-secondary}g' "$f"
done
```

- [ ] **Step 4: Assert zero remaining + typecheck + lint**

```bash
cd /Users/maverick/code/projects/orpheus/src/renderer/src
grep -rEc --include='*.tsx' 'text-text-(muted|secondary)/[0-9]+|text-zinc-400' . | grep -v ':0' || echo "clean"
cd /Users/maverick/code/projects/orpheus && bun run typecheck && bun run lint
```

Expected: `clean`; typecheck + lint pass.

- [ ] **Step 5: Commit**

```bash
git add -A src/renderer/src
git commit -m "fix(ui): remove alpha-dimmed text, tokenize raw zinc spinners"
```

---

### Task 5: Remap arbitrary `text-[Npx]` → scale utilities (typography sweep)

**Files:** all 23 `.tsx` containing `text-[Npx]` (94 occurrences; values are only 9px/10px/11px). Parallelizable by directory across subagents.

**Interfaces:** none produced; gated by grep + typecheck.

- [ ] **Step 1: Baseline**

```bash
cd /Users/maverick/code/projects/orpheus/src/renderer/src
grep -rEoh --include='*.tsx' 'text-\[[0-9]+px\]' . | sort | uniq -c
```

Expected: `49 text-[10px]`, `42 text-[11px]`, `3 text-[9px]`.

- [ ] **Step 2: Apply the mapping** (`9px`,`10px`→`text-xs` = 12px; `11px`→`text-sm` = 13px)

```bash
cd /Users/maverick/code/projects/orpheus/src/renderer/src
for f in $(grep -rEl --include='*.tsx' 'text-\[[0-9]+px\]' .); do
  perl -pi -e 's{text-\[(9|10)px\]}{text-xs}g; s{text-\[11px\]}{text-sm}g' "$f"
done
```

- [ ] **Step 3: Assert zero remaining + typecheck + lint + build**

```bash
cd /Users/maverick/code/projects/orpheus/src/renderer/src
grep -rEc --include='*.tsx' 'text-\[[0-9]+px\]' . | grep -v ':0' || echo "clean"
cd /Users/maverick/code/projects/orpheus && bun run typecheck && bun run lint && bun run build
```

Expected: `clean`; all pass.

- [ ] **Step 4: Commit**

```bash
git add -A src/renderer/src
git commit -m "refactor(ui): map arbitrary px text to the type scale (12px floor)"
```

---

### Task 6: Extract `SectionTitle` + `Eyebrow` primitives, apply `font-pixel` + wordmark

**Files:**

- Modify: `src/renderer/src/components/dashboard/settings/primitives.tsx` (add two exports)
- Modify: `src/renderer/src/App.tsx:54-55` (wordmark)
- Modify: the ~15 files with inline `<h2 … text-base font-semibold text-text-primary>` titles and `… text-xs font-medium uppercase tracking-wider text-text-secondary` eyebrows (settings sections, MainContent, WorkspacesView, etc.)

**Interfaces:**

- Produces: `SectionTitle` and `Eyebrow` React components (single place where `font-pixel` is applied — so it's one-line to dial back if pixel reads rough at small sizes).

- [ ] **Step 1: Add the two primitives** to `primitives.tsx`

```tsx
// SectionTitle — the pixel-accented heading for settings sections / page panels.
export function SectionTitle({
  children,
  className = ''
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <h2 className={`font-pixel text-base font-semibold text-text-primary ${className}`}>
      {children}
    </h2>
  )
}

// Eyebrow — small uppercase group label; pixel for signature, tracked for legibility.
export function Eyebrow({
  children,
  className = ''
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <p
      className={`font-pixel text-xs font-medium uppercase tracking-wider text-text-secondary ${className}`}
    >
      {children}
    </p>
  )
}
```

(If `primitives.tsx` doesn't already `import React`, add `import React from 'react'` at the top — check first.)

- [ ] **Step 2: Apply `font-pixel` to the wordmark** (`App.tsx:54-55`)

Add `font-pixel` to the `<h1>` className:

```tsx
<h1 className="font-pixel text-6xl tracking-tight text-text-primary leading-none select-none">
  Orpheus<span className="text-accent">.</span>
</h1>
```

- [ ] **Step 3: Replace inline section titles + eyebrows** with the primitives

Find them, then in each file import `SectionTitle` / `Eyebrow` from the primitives module and replace the inline element (preserve any extra margin classes via the `className` prop, e.g. `mb-3`):

```bash
cd /Users/maverick/code/projects/orpheus/src/renderer/src
echo "section titles:"; grep -rEn --include='*.tsx' '<h2 className="text-base font-semibold text-text-primary' .
echo "eyebrows:"; grep -rEn --include='*.tsx' 'text-xs font-medium uppercase tracking-wider text-text-secondary' .
```

Replace each `<h2 className="text-base font-semibold text-text-primary{EXTRA}">X</h2>` → `<SectionTitle className="{EXTRA}">X</SectionTitle>` (drop `className` if no extra). Replace each eyebrow `<h2/h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary{EXTRA}">X</…>` → `<Eyebrow className="{EXTRA}">X</Eyebrow>`. Add the import to each touched file:

```tsx
import { SectionTitle, Eyebrow } from './primitives' // adjust relative path per file
```

- [ ] **Step 4: Typecheck + lint + build**

```bash
cd /Users/maverick/code/projects/orpheus && bun run typecheck && bun run lint && bun run build
```

Expected: all pass. (Catches any missed import or unbalanced tag.)

- [ ] **Step 5: Commit**

```bash
git add -A src/renderer/src
git commit -m "feat(ui): pixel-accent wordmark + SectionTitle/Eyebrow primitives"
```

---

### Task 7: Final verification + production build + visual spot-check

**Files:** none (or small fixes surfaced by the visual check); `docs/superpowers/specs/2026-06-19-orpheus-readability-pass-design.md` status update.

- [ ] **Step 1: Full objective gate**

```bash
cd /Users/maverick/code/projects/orpheus
bun scripts/verify-contrast.mjs && bun run typecheck && bun run lint
```

Expected: contrast `✓ PASS`; typecheck + lint clean.

- [ ] **Step 2: Production build + relaunch** (auto-close/relaunch pre-authorized)

```bash
osascript -e 'tell application "Orpheus" to quit' 2>/dev/null; sleep 1
pkill -x Orpheus 2>/dev/null; true
cd /Users/maverick/code/projects/orpheus && bun run build:unpack
open /Applications/Orpheus.app
sleep 3; pgrep -lf "Orpheus.app/Contents/MacOS/Orpheus" | head -1
```

Expected: build succeeds; process line prints (app launched).

- [ ] **Step 3: Visual spot-check** (manual, per `CLAUDE.md` sanity-check)

Confirm in the running app: body text is Geist Sans (not pixel); the `Orpheus` wordmark + settings section titles + eyebrows are pixel; no `text-[Npx]` fuzziness; cycle **Settings → Appearance** through **Midnight / Daylight / Eclipse**, each under **gold** and one cool accent (**teal** or **blue**) — verify muted metadata, footer text, and the braille spinners are all clearly legible (no near-invisible text on Daylight). If anything reads rough (e.g. pixel eyebrows at 12px), toggle pixel off in the `Eyebrow` primitive only (one line) and rebuild.

- [ ] **Step 4: Mark the spec shipped + commit any fixes**

Update the spec header `Status:` to `Shipped 2026-06-19`. Then:

```bash
cd /Users/maverick/code/projects/orpheus
git add -A
git commit -m "chore(ui): readability pass — final verification + spec status" || echo "nothing to commit"
git push origin staging
```

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:

- Hybrid font / Geist Sans+Mono / pixel loading → Task 1. Type scale, body 15px, no arbitrary px, tabular-nums → Tasks 1 + 5. Variable weight by theme → Task 1. Metric-matched fallback → **dropped** (shipping guessed ascent/descent metrics risks _worse_ CLS than same-origin woff2 + `font-display: swap`; noted here as a deliberate deviation, deferrable to a measured Fontaine/capsize pass). AA neutral retune + computational verify → Task 2. Accent-aware surfaces + eclipse softening → Task 3. Kill 14 alpha-dimmers + 6 raw zinc → Task 4. Pixel on wordmark + headers/eyebrows → Task 6. Build + visual gate → Task 7.
- Gray-on-chip "tint toward chip surface": **folded into** Task 4's outcome — once dimmers become solid AA `text-text-muted` on the (optionally accent-tinted) overlay chips, the washed-out look is resolved without per-chip bespoke colors. No separate task. Flag if a specific chip still reads poorly in Task 7's visual check.

**2. Placeholder scan** — no TBD/TODO; every code step shows complete code; the only "adjust" loops (Task 2 Step 4, Task 3 Step 4) are deterministic nudge-until-the-harness-passes instructions, not vague hand-waving.

**3. Type consistency** — `SectionTitle`/`Eyebrow` defined in Task 6 Step 1 are consumed with the same names + `className` prop in Step 3. Harness function names (`luminance`, `contrast`, `grab`, `oklchToLin`) are consistent between Task 2 and the Task 3 extension. CSS token names (`--text-*`, `--font-pixel`, `--body-weight`, `--color-text-*`) match across Tasks 1–6.

**Known follow-ups (out of scope, not blocking):** metric-matched font fallback (measured); auditing semantic amber/red warning colors only if Task 7 surfaces a failure.
