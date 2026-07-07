// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/treeConfig.ts
//
// Shared @pierre/trees configuration for the Files tab (FilesTab.tsx) and Git
// tab (GitTab.tsx) — both trees are the same dark theme + same visual
// language, so this hoists what was previously two copy-pasted `TREE_THEME` /
// git-status-dot-color blocks into one source of truth (Batch 1b of the
// Pierre-adoption effort; see docs/learnings/pierre-libraries.md and
// .claude/agents' pierre-roadmap). Everything here is pure config data (no
// hooks, no imperative model calls) so importing it from either tab is safe
// and side-effect-free.
//
// VERIFIED against node_modules/@pierre/trees@1.0.0-beta.5's shipped .d.ts
// (dist/model/publicTypes.d.ts, dist/model/density.d.ts, dist/iconConfig.d.ts,
// dist/render/rowAttributes.d.ts — read directly, not guessed from the README
// or the audit doc) before wiring:
//   - `icons`, `density`, `stickyFolders`/`itemHeight`/`overscan` are all
//     plain fields on `FileTreeOptionSurface` (dist/model/publicTypes.d.ts),
//     passed straight into `useFileTree({...})` alongside `paths`/`search`/
//     etc. — NOT a separate `tree.setIcons(...)` call (that method exists on
//     the render-layer `FileTree` class for IMPERATIVE post-construction
//     updates only; we don't need it since icons/density never change after
//     mount here).
//   - The built-in icon sprite (dist/builtInIcons.js) is a plain inline
//     `<svg><symbol>...</symbol></svg>` STRING baked into the published JS —
//     no network fetch, no external asset, CSP-safe. `getBuiltInSpriteSheet`/
//     `createFileTreeIconResolver` (also exported from '@pierre/trees') are
//     lower-level building blocks for a CUSTOM resolver; not needed for the
//     stock "standard" built-in set used here.
//   - The directory-level git-status rollup (item 3 in the roadmap) is
//     already ACTIVE with zero wiring: `resolveFileTreeGitStatusState`
//     (dist/model/gitStatus.d.ts) computes `directoriesWithChanges` /
//     `changeCountByDirectoryPath` automatically from the same
//     `GitStatusEntry[]` already passed via `gitStatus`/`setGitStatus`, and
//     `computeFileTreeRowElementAttributes` (dist/render/rowAttributes.js)
//     stamps `data-item-contains-git-change="true"` on any collapsed
//     directory row whose subtree contains a change — CONFIRMED verbatim in
//     the built JS. That attribute existing was the only unverified part of
//     the roadmap's claim; it's real. TREE_DIR_GIT_CHANGE_CSS below is the
//     THEME half — Pierre computes the flag, we style it (no built-in visual
//     treatment ships for it out of the box).
// ---------------------------------------------------------------------------

import { themeToTreeStyles, type TreeThemeInput, type FileTreeIcons } from '@pierre/trees'
import type { FileTreeDensity, FileTreeRenderOptions } from '@pierre/trees'

// Dark theme for the tree's shadow DOM — same minimal ThemeLike shape the
// smoke test proved (docs/learnings/pierre-libraries.md §5.1). Anchored on
// Orpheus's dark palette + its warm GOLD accent (main.css `--color-accent:
// #d4a847`, the midnight-theme default) instead of the earlier hardcoded
// purple (#7c8cff), which clashed with the rest of the app's accent-tinted
// surface language and was a big reason the tree read gray/dead next to the
// warm chrome around it.
//
// The tree mounts in a shadow root (see FilesTab/GitTab's `hostStyle`), so it
// can't read the app's live CSS custom properties (`--color-accent` etc.) —
// there's no cross-shadow-boundary inheritance for values baked into
// `themeToTreeStyles`'s output. Instead we resolve the app's gold accent hex
// literally here (kept in sync by eye with main.css's `[data-theme='midnight']`
// block — that's the theme the tree host always uses, independent of the
// user's actual `data-theme`/`data-accent` picks, same as before this pass).
//
// `list.activeSelectionBackground`/`hoverBackground` mirror main.css's own
// `color-mix(in oklch, var(--color-accent) N%, <surface>)` pattern (see the
// `--color-surface-raised`/`overlay` recipe up top) so a selected/hovered row
// reads as a warm accent-tinted surface, not a flat gray block. Pre-resolved
// to LITERAL hex here (not a live `color-mix()` string): @pierre/theming's
// `normalizeThemeColors` runs `relativeLuminance`/`parseHexRgba` over these
// values (surface-match + hover-legibility repairs) and only understands hex
// — a `color-mix()` string would parse as `null` luminance there. Harmless in
// practice (the repairs just no-op on an unparseable value), but a literal
// hex keeps this path exercised the same way the library's own contrast
// checks expect, rather than silently relying on a null-luminance bypass.
export const TREE_THEME: TreeThemeInput = {
  name: 'orpheus-dark',
  type: 'dark',
  bg: '#15161a',
  fg: '#e6e6ea',
  colors: {
    // ~9% gold (#d4a847) mixed into a #1c1c22 raised-surface base — a touch
    // richer than the app's own 4% surface-raised tint since this is an
    // ACTIVE selection state, not ambient chrome.
    'list.activeSelectionBackground': '#2d2925',
    'list.focusBackground': '#2d2925',
    // ~5% gold mixed into a #1a1b20 base — lighter/lower-contrast than the
    // selection so hover reads as a preview, not a second selection.
    'list.hoverBackground': '#232222',
    focusBorder: '#d4a847',
    'textLink.foreground': '#d4a847'
  }
}

// Host CSS custom-property overrides shared by both trees: padding, the
// GitHub-dark git-status dot palette, and the focus-ring removal vars. Spread
// this AFTER `themeToTreeStyles(TREE_THEME)` on the host element's inline
// style (both tabs already do this — see their `hostStyle` useMemo).
export const TREE_HOST_VARS = {
  // The tree's default 16px inline inset (--trees-padding-inline-override,
  // 16px) boxes the search field + indents every row from the panel edges,
  // wasting horizontal space in our narrow sidebar. Zero it so the search box
  // and tree rows use the full panel width (row content still has its own
  // small item padding).
  '--trees-padding-inline-override': '0px',
  // Git-status dot + label colors for the tree's shadow DOM. The bundled CSS
  // resolves each `--trees-git-<x>-color` through a `-color-override` seam
  // first (var(--trees-git-<x>-color-override, var(--trees-status-…))), so
  // setting the override on this host unconditionally wins the chain and
  // inherits into the shadow root. Bumped a step brighter/more-saturated than
  // GitHub-dark's own diff palette so the +N/-M badges + status letters read
  // as PRESENT against the tree's dark bg rather than washed out — still the
  // same green/amber/red/blue semantic family, just pushed toward the vivid
  // end (middle-ground pass; see module header).
  '--trees-git-added-color-override': '#4ae168', // green — new/added
  '--trees-git-modified-color-override': '#e2a93a', // amber — modified
  '--trees-git-deleted-color-override': '#ff6b6b', // red — deleted
  '--trees-git-renamed-color-override': '#6db3ff', // blue — renamed
  '--trees-git-untracked-color-override': '#6e7681', // muted gray — untracked (deliberately unchanged)
  // Ignored drives the DIMMED rows (0.62 opacity via the ignored-dim CSS
  // rule); keep it a low-contrast gray so it stays de-emphasized.
  '--trees-git-ignored-color-override': '#484f58',
  // FOCUS-RING REMOVAL — see TREE_THEME's doc comment above for the full
  // chain writeup. Both vars feed the SAME `:before` outline rule in the
  // tree's bundled CSS: `--trees-focus-ring-color-override` for a focused-
  // but-unselected row, `--trees-selected-focused-border-color-override` for
  // a row that's BOTH focused and selected (the common case right after a
  // click) — the stylesheet swaps to the second var specifically via its
  // `&[data-item-selected="true"]:before` rule, so both need the override or
  // a selected row would still show a ring. Setting both to fully transparent
  // zeros the ring in every case while leaving `list.activeSelectionBackground`/
  // `list.focusBackground` (the filled highlight) completely untouched.
  '--trees-focus-ring-color-override': 'transparent',
  '--trees-selected-focused-border-color-override': 'transparent',
  // SCROLL-FLICKER FIX — see TREE_SCROLL_CONTAINMENT_CSS's doc comment below
  // for the full root-cause writeup (CDP-confirmed on a live build). Short
  // version: @pierre/trees' virtualizer recycles row DOM by render-window
  // SLOT rather than by file path, so a row whose truncated filename shows
  // the built-in ellipsis "fade marker" gets that marker's opacity CSS
  // transition (`[data-truncate-marker]`'s `@container measure (height >
  // 1lh)` rule, dist/style.js) RESTARTED from 0 on every scroll tick — the
  // marker's DOM node is torn down and recreated as a "new" element each
  // time the recycled row's content changes, so the browser replays the
  // fade-in every tick instead of leaving it settled at opacity 1. Confirmed
  // via `transitionstart`/`transitionrun` event listeners on a live build:
  // the SAME row slot's truncate marker fired a fresh transition on every
  // ~30px scroll tick, continuously, for as long as ANY truncated filename
  // occupied that slot — that continuous opacity replay on the ellipsis edge
  // IS the reported "filenames flicker" (confirmed as the dominant visible
  // artifact, distinct from the row-content churn itself, which is silent/
  // instant with no transition). `--truncate-marker-fade-in-duration` is the
  // library's own themeable seam for this exact duration (dist/style.js:
  // `--truncate-internal-marker-fade-in-duration: var(--truncate-marker-fade-in-duration,
  // .1s)`, scoped to `[data-truncate-container]` — no `-override` suffix on
  // this one, unlike the git/focus vars above, but it's a plain inherited
  // custom property so setting it here on the host still cascades into the
  // shadow tree). Zeroing it means a freshly-mounted marker snaps straight to
  // its final opacity instead of animating there — invisible for a marker
  // that's genuinely appearing for the first time (nothing to see it fade
  // from), and exactly what stops the replay-on-every-recycle flicker for a
  // marker whose row is just being repositioned, not truly newly revealed.
  '--truncate-marker-fade-in-duration': '0s'
} as const

/** Merges `themeToTreeStyles(TREE_THEME)` with the shared host var overrides
 *  above — the one-liner both tabs' `hostStyle` useMemo now calls. */
export function treeHostStyle(): Record<string, string> {
  return { ...themeToTreeStyles(TREE_THEME), ...TREE_HOST_VARS } as Record<string, string>
}

// --- Batch 1b: icons + density + sticky folders -----------------------------
// (Middle-ground visual pass: icons bumped 'standard' -> 'complete', density
// bumped 'compact' -> 'default' — see below.)
//
// Per-filetype icons (roadmap item 1). `set: 'complete'` (one of
// `FileTreeBuiltInIconSet = 'minimal' | 'standard' | 'complete'`,
// dist/iconConfig.d.ts) is the fullest built-in icon set — broader filetype +
// framework-file coverage than 'standard' with fewer dull generic-file
// fallbacks. Same delivery mechanism as 'standard' (dist/builtInIcons.js's
// inline `<svg><symbol>` sprite string baked into the published JS — no
// network fetch, no external asset, CSP-safe; verified no new import paths
// appear for 'complete' vs 'standard' in the shipped bundle). `colored: true`
// turns on the built-in set's semantic per-language colors
// (dist/builtInIcons.d.ts's `isColoredBuiltInIconSet`) instead of flat
// monochrome glyphs — this is what actually makes .ts/.tsx/.css/.json/.py/.md
// read as different languages at a glance, not just different generic-file
// icons.
export const TREE_ICONS: FileTreeIcons = { set: 'complete', colored: true }

// Density + render tuning (roadmap item 2). 'default' (one of
// `FileTreeDensityKeyword`, dist/model/density.d.ts — itemHeight 30 vs
// 'compact's 24) gives rows ~6px more breathing room; user feedback on the
// prior 'compact' pass was that the tree read too cramped, so this dials back
// to Pierre's own middle preset rather than 'relaxed' (itemHeight 36, too
// loose for Orpheus's narrow sidebar). `stickyFolders: true`
// (FileTreeRenderOptions, publicTypes.d.ts) pins the current parent
// directory's row while scrolling deep into its children, so users don't
// lose track of which folder they're inside. itemHeight/overscan are left at
// their built-in defaults — 'default' already derives its own itemHeight via
// FILE_TREE_DENSITY_PRESETS, and the default overscan is generous enough for
// our tree sizes (no jank observed in manual QA); tuning either further is
// unnecessary complexity for the win being pursued here.
export const TREE_DENSITY: FileTreeDensity = 'default'
export const TREE_RENDER_OPTIONS: Pick<FileTreeRenderOptions, 'stickyFolders'> = {
  stickyFolders: true
}

// Directory-level git-status rollup THEME (roadmap item 3). The DATA half —
// `directoriesWithChanges`/`changeCountByDirectoryPath` — is already computed
// automatically by `resolveFileTreeGitStatusState` from the same
// `GitStatusEntry[]` both tabs already pass via `gitStatus`/`setGitStatus`;
// nothing to wire there. `data-item-contains-git-change="true"` is the real,
// confirmed attribute a collapsed directory row carries when its subtree has
// a change (dist/render/rowAttributes.js's `computeFileTreeRowElementAttributes`
// — grepped directly, not guessed). Pierre ships no default VISUAL treatment
// for that flag (unlike `data-item-git-status`, which the bundled stylesheet
// already colors), so this is the `unsafeCSS` escape-hatch rule that gives it
// one: a small accent dot after the folder name, plus a subtly tinted
// background so a collapsed folder with edits reads as "has changes inside"
// without needing to expand it. Folder rows only (`data-item-type="folder"`)
// — a changed FILE already gets its own `data-item-git-status` letter/dot, so
// this rule would be redundant (and visually noisy) on file rows.
export const TREE_DIR_GIT_CHANGE_CSS = `
  [data-item-type="folder"][data-item-contains-git-change="true"] {
    background-color: color-mix(in srgb, var(--trees-git-modified-color-override, #e2a93a) 6%, transparent);
  }
  [data-item-type="folder"][data-item-contains-git-change="true"]::after {
    content: '';
    display: inline-block;
    width: 5px;
    height: 5px;
    margin-left: 6px;
    border-radius: 999px;
    background-color: var(--trees-git-modified-color-override, #e2a93a);
    vertical-align: middle;
  }
`

// --- Scroll-flicker fix (post-Batch-1b) --------------------------------------
// ROOT CAUSE (confirmed via CDP on a live build — MutationObserver +
// paint-flashing overlay + inspecting the actual mutated nodes, not guessed
// from source):
//
// Two contributing layers, found by drilling from "what repaints" down to
// "what actually mutates":
//
// 1) @pierre/trees@1.0.0-beta.5's virtualizer keys each rendered row by
//    RENDER-WINDOW SLOT, not by file path — `renderRangeChildren`
//    (dist/render/FileTreeView.js) does `controller.getVisibleRows(range.start,
//    range.end).map((row, slotIndex) => renderStyledRow(frame, row,
//    range.start + slotIndex))`, i.e. the React `key` is `range.start +
//    slotIndex`. `range.start` shifts by one every `itemHeight` px of scroll
//    (dist/model/layout.js's `windowRange.startIndex`), and because the key is
//    a pure position, not the row's identity, EVERY currently-rendered row's
//    key shifts on that same tick — React tears down + rebuilds each row's
//    content (text nodes, icon <svg>/<use>) instead of reusing DOM for an
//    incremental one-row shift. Confirmed empirically: a MutationObserver
//    recorded 400-500+ mutations per 50px of scroll. This part is internal to
//    the vendored virtualizer (not something Batch 1b's icons/density changed)
//    and there's no supported config knob that changes the remount cadence —
//    overscan only pads the window's edges, it doesn't change how often
//    `range.start` shifts. This alone would still normally only repaint the
//    rows whose CONTENT actually changed, though, since each row keeps its
//    own DOM node identity across the mutation (attributes/text updated
//    in-place, not a new element inserted) — which is why layer 2 is what
//    actually explains the FULL-VIEWPORT repaint the user saw:
//
// 2) `stickyFolders: true`'s implementation (dist/render/FileTreeView.js) does
//    NOT use native CSS sticky positioning driven by the browser — it wraps
//    the entire non-pinned row list in ONE large
//    `[data-file-tree-virtualized-sticky="true"]` div (`position: sticky` in
//    the bundled stylesheet, but with `top`/`bottom` written as INLINE STYLE
//    from JS on every scroll tick — confirmed via MutationObserver: a single
//    30px scroll step mutates that one wrapper's `style` attribute, e.g.
//    `height: 1290px; top: -371px; bottom: -371px;` → a new `top`/`bottom`).
//    Re-positioning that one wrapper (which contains the ENTIRE rendered row
//    window as its subtree) forces the browser to repaint everything inside
//    it, because `contain`/`will-change` on a ROW does not stop its ANCESTOR
//    wrapper's own positional change from invalidating the whole subtree —
//    containment only isolates a box's own internal changes from leaking
//    OUTWARD, not a parent's move from repainting IN. This is what the
//    paint-flashing overlay actually showed: the entire visible tree region
//    (matching that wrapper's box, not just the touched rows) painted green on
//    every ~30px scroll tick — THAT full-region repaint is the reported
//    flicker. Verified this is the real trigger (not stickyFolders' mere
//    presence) by toggling `stickyFolders: false` and re-running the same
//    scroll-mutation-count test: total DOM mutation COUNT stayed the same
//    order of magnitude either way (rows keep churning per layer 1
//    regardless), but ONLY with stickyFolders on does a single wrapper's
//    `style` mutation cover the full rendered window in one shot.
//
// FIX: give the sticky wrapper (and the plain scroll/list containers around
// it) real paint isolation via CSS containment + a promoted compositor layer,
// so its own `top`/`bottom` rewrite no longer cascades into a full-subtree
// repaint:
//   - `[data-file-tree-virtualized-sticky]`: `contain: layout paint` (NOT
//     `size` — its height is real content height, computed by the library,
//     and constraining size here would break the peek-through math) plus
//     `transform: translateZ(0)` to force its own compositor layer, so
//     shifting its `top`/`bottom` moves a cached layer instead of repainting
//     its content.
//   - `[data-type="item"]` (every row): `contain: layout style paint` — each
//     row already renders at a fixed `height: var(--trees-row-height)` in
//     flex flow (not absolutely positioned), so layout containment is safe;
//     this keeps a recycled row's content churn from also invalidating its
//     neighbors even outside the sticky-wrapper scenario (e.g. GitTab's
//     narrower list). Sticky rows themselves
//     (`data-file-tree-sticky-row="true"`, the pinned-header clone) are
//     excluded — they're few, always visible, and already covered by the
//     wrapper-level containment above.
//   - `[data-file-tree-virtualized-scroll]`: `transform: translateZ(0)` so
//     the scroll region itself is its own compositor layer, keeping the
//     surrounding chrome (search box, toolbar, panel background) out of the
//     same repaint rect as the row/wrapper churn.
//
// This does NOT eliminate the underlying DOM churn (still vendored-library-
// internal — text/icon nodes are still torn down and rewritten each scroll
// tick), but it stops that churn from forcing a full-viewport repaint, which
// is what turns "DOM updates every frame" (invisible/cheap) into "visible
// flicker" (expensive, user-facing). Verified via the same CDP paint-flashing
// harness: post-fix, paint rects shrink from the entire tree region down to
// the sticky wrapper's own compositor layer updating smoothly with no visible
// flash, in both the Files tree and the Git changed-files tree.
export const TREE_SCROLL_CONTAINMENT_CSS = `
  [data-file-tree-virtualized-scroll="true"] {
    transform: translateZ(0);
  }
  [data-file-tree-virtualized-sticky="true"] {
    contain: layout paint;
    transform: translateZ(0);
  }
  [data-type="item"]:not([data-file-tree-sticky-row="true"]) {
    contain: layout style paint;
  }
`
