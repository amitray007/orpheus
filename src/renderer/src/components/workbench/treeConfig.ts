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
// Orpheus's dark palette + the #7c8cff accent for links.
//
// FOCUS-RING REMOVAL: `focusBorder` here does NOT drive the selected/focused
// row's outline ring by itself — `themeToTreeStyles` doesn't read
// `focusBorder` directly at all; it goes through `@pierre/theming`'s
// `normalizeThemeColors`, which folds `focusBorder` into `list.focusOutline`
// (first non-transparent of the two) and that becomes
// `--trees-theme-focus-ring`. The tree's own bundled CSS then resolves the
// ring color through `--trees-focus-ring-color-override` →
// `--trees-theme-focus-ring` → `--trees-accent` (see
// node_modules/@pierre/trees/dist/style.js's `[data-item-focused="true"]:before`
// rule) — so simply setting `focusBorder: 'transparent'` here would only drop
// out of the chain and fall through to `--trees-accent`, NOT actually zero the
// ring. The reliable fix is the `-override` CSS vars in TREE_HOST_VARS below
// (win the chain unconditionally). `focusBorder` is left as-is (harmless —
// its own link in the chain is now moot since the override wins first) rather
// than removed, so a future theme swap that drops the override doesn't
// silently reintroduce a stray ring with no explanation.
export const TREE_THEME: TreeThemeInput = {
  name: 'orpheus-dark',
  type: 'dark',
  bg: '#15161a',
  fg: '#e6e6ea',
  colors: {
    'list.activeSelectionBackground': '#2a2c3a',
    'list.focusBackground': '#2a2c3a',
    'list.hoverBackground': '#1f2028',
    focusBorder: '#7c8cff',
    'textLink.foreground': '#7c8cff'
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
  // inherits into the shadow root. GitHub-dark diff palette:
  '--trees-git-added-color-override': '#3fb950', // green — new/added
  '--trees-git-modified-color-override': '#d29922', // amber — modified
  '--trees-git-deleted-color-override': '#f85149', // red — deleted
  '--trees-git-renamed-color-override': '#58a6ff', // blue — renamed
  '--trees-git-untracked-color-override': '#6e7681', // muted gray — untracked
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
  '--trees-selected-focused-border-color-override': 'transparent'
} as const

/** Merges `themeToTreeStyles(TREE_THEME)` with the shared host var overrides
 *  above — the one-liner both tabs' `hostStyle` useMemo now calls. */
export function treeHostStyle(): Record<string, string> {
  return { ...themeToTreeStyles(TREE_THEME), ...TREE_HOST_VARS } as Record<string, string>
}

// --- Batch 1b: icons + density + sticky folders -----------------------------
//
// Per-filetype icons (roadmap item 1). `set: 'standard'` is the mid-tier
// built-in icon set (`FileTreeBuiltInIconSet = 'minimal' | 'standard' |
// 'complete'`, dist/iconConfig.d.ts) — richer than 'minimal' (which only
// covers file/folder/chevron/dot/lock), without pulling in 'complete's long
// tail of framework-specific marks we don't need. `colored: true` turns on
// the built-in set's semantic per-language colors (dist/builtInIcons.d.ts's
// `isColoredBuiltInIconSet`) instead of flat monochrome glyphs — this is what
// actually makes .ts/.tsx/.css/.json/.py/.md read as different languages at a
// glance, not just different generic-file icons.
export const TREE_ICONS: FileTreeIcons = { set: 'standard', colored: true }

// Density + render tuning (roadmap item 2). 'compact' (one of
// `FileTreeDensityKeyword`, dist/model/density.d.ts) fits more rows on screen
// for large repos — Orpheus's sidebar is narrow and vertical space is at a
// premium. `stickyFolders: true` (FileTreeRenderOptions, publicTypes.d.ts)
// pins the current parent directory's row while scrolling deep into its
// children, so users don't lose track of which folder they're inside.
// itemHeight/overscan are left at their built-in defaults — 'compact'
// already derives its own itemHeight via FILE_TREE_DENSITY_PRESETS, and the
// default overscan is generous enough for our tree sizes (no jank observed
// in manual QA); tuning either further is unnecessary complexity for the
// win being pursued here.
export const TREE_DENSITY: FileTreeDensity = 'compact'
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
    background-color: color-mix(in srgb, var(--trees-git-modified-color-override, #d29922) 6%, transparent);
  }
  [data-item-type="folder"][data-item-contains-git-change="true"]::after {
    content: '';
    display: inline-block;
    width: 5px;
    height: 5px;
    margin-left: 6px;
    border-radius: 999px;
    background-color: var(--trees-git-modified-color-override, #d29922);
    vertical-align: middle;
  }
`
