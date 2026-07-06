// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/GitTab.tsx
//
// Workbench Git tab — Phase 1: the working-tree DIFF VIEWER foundation
// (docs/brainstorms/2026-07-06-git-tab-requirements.md states 3 "uncommitted
// changes, no PR" + 4 "ahead of base, no PR"). NO PR chrome, comments, or
// Details/Checks tabs — those are later phases; the [Diff | Commits] strip
// below only builds Diff, Commits is a stub.
//
// Layout mirrors FilesTab.tsx (see its module header): a changed-files TREE
// (left, @pierre/trees, git-status-decorated) + a diff PANE (right,
// @pierre/diffs' <PatchDiff>) fed by the new `git:diff` IPC's per-file patch
// strings (src/main/gitDiff.ts). Reuses FilesTab's dark-theme idioms
// (TREE_THEME/themeToTreeStyles, the git-status dot color overrides,
// PIERRE_VIEWER_BG) rather than re-deriving a second palette — see
// docs/learnings/pierre-libraries.md §5/§13.
//
// Header row (h-8, like FilesTab's): a hide-tree icon, a unified/split icon
// toggle (diffStyle), a worktree/local chip, and a [Diff | Commits] sub-tab
// strip (Commits is a Phase-3 stub).
//
// Live refresh: subscribes to `git:statusChanged` (src/main/git.ts's .git
// watcher — started unconditionally on terminal:mount, covers branch/index
// changes) AND `files:changed` (filesWatcher.ts — working-tree file
// create/edit/delete). git.ts's watcher alone is NOT enough: it only covers
// `.git/HEAD` + `.git/index`, so a bare file save never touches either and
// never fires it — the tab would only refresh incidentally (e.g. via a
// staging operation) and feel slow/stale for a plain edit.
//
// PERF FIX (this pass): GitTab now DRIVES filesWatcher.ts itself — starting
// the working-tree watch on mount and stopping it on unmount, exactly like
// FilesTab.tsx does (see its own watchStart/watchStop effect). This used to
// be explicitly disallowed here ("must NOT call files:watchStart, would
// fight the single-active invariant") because filesWatcher.ts allows only
// ONE active watcher app-wide. That reasoning no longer blocks this: the Git
// and Files tabs are mutually exclusive Workbench tabs (WorkbenchPanel mounts
// at most one of them at a time), so whichever one is active owns the
// single watcher slot for as long as it's shown, and there is never a moment
// both are mounted to contend over it. Unmount (tab switch, workspace
// change) always stops the watch it started, so the handoff to the other
// tab's own watchStart is clean.
//
// Combined with the idempotent applyDiff no-op below (diffSignature), this
// is what makes updates fast WITHOUT reintroducing the flicker loop that was
// just fixed: the watcher now fires promptly on a real change, but an
// unchanged git:diff result is still a complete no-op (no re-render).
//
// Gating: mounted only while the Git tab is the active, non-dormant
// Workbench tab (see WorkbenchPanel) — git:diff is never fetched while the
// tab isn't visible.
//
// Phase 1 refinements (this pass):
//   FIX 1 — auto-select the first changed file when the diff loads/refreshes
//     and nothing is selected (or the prior selection dropped out), so the
//     tab shows a diff immediately instead of an empty "Select a file" state.
//   FIX 2 — a ⚙ GitDiffOptionsPopover (mirrors FilesTab's TreeOptionsPopover)
//     holding a "Wrap lines" toggle for the diff viewer, persisted app-wide
//     via AppUiState.gitDiffWrapLines (same files_wrap_lines pattern), plus a
//     search-icon toggle for the changed-files tree (mirrors FilesTab's
//     TreeToolbar search-icon-toggle fix). NOTE: "search in git commits" is a
//     separate ask — the Commits sub-tab is a Phase-3 stub today, so
//     commit-search lands there, not here; this only searches changed FILES.
//   FIX 3 — (superseded) a custom per-row "+N -M" count decoration was tried
//     and then explicitly reversed: the changed-files tree renders NO custom
//     row content at all now — just @pierre/trees' own native git-status
//     letter (U/M/A/D/R) via `setGitStatus`/`toTreeGitStatus`, see the
//     "Changed-files tree pane" section below for why.
//   FIX 4 — binary files (gitDiff.ts flags `binary: boolean`) never reach
//     <PatchDiff> (which would render a blank pane for one); the diff pane
//     instead renders the current image (via files:readImage) for image
//     extensions, or a "no preview" placeholder for other binary files. (The
//     changed-files ROW no longer shows a "Binary" label — see FIX 3 above —
//     this is the diff PANE's own binary handling only.)
//
// Phase 2 — edge states (docs/brainstorms/2026-07-06-git-tab-requirements.md
// states 1 "not a git repo" + 2 "clean/no changes"; mockup's Edge-states
// panel): `git:diff`'s result now carries a `repo: boolean` discriminator
// (src/shared/types.ts's GitDiffResult) so this component can tell "not a
// git repo" apart from "clean tree" — both previously resolved to the same
// empty `files: []}`. Three render branches: `!repo` → a centered empty
// state with a "Git init" button (calls the new `git:init` IPC, then
// explicitly refetches `git:diff` — the watcher may not pick up a brand-new
// `.git` dir immediately, so this doesn't rely on live-refresh); `repo &&
// files.length === 0` → a centered "No changes" empty state; otherwise the
// unchanged Phase-1 tree+diff view.
//
// Phase 3a — PR detection + slim header (docs/brainstorms/
// 2026-07-06-git-tab-requirements.md "Full-PR experience" → slim header;
// mockup's `.pr-header--slim`). NO new IPC needed: `startGitWatch`
// (src/main/git.ts, started unconditionally on `terminal:mount` — see
// index.ts) already resolves the current branch's PR via `getPrForBranch`
// and pushes it over the existing `github:prChanged` channel — once on the
// initial watch registration, and again every time the branch changes. So
// this component just subscribes to `window.api.github.onPrChanged` (same
// pattern as its existing `git:statusChanged` subscription) and stores
// whatever arrives; there's no separate fetch call to make or cwd to plumb
// down. `pr: null` (no PR / no `gh` / no remote / detached HEAD) renders
// the header as it did before this phase — the slim header is additive,
// gated entirely on `pr !== null`.
//
// Slim header fields, matching the mockup's `renderPrHeader` 1:1: a colored
// status badge (open/draft/merged/closed → the app's own `--color-gh-*`
// tokens, reusing `PrChip`'s STATE_COLOR/STATE_LABEL rather than
// re-deriving a second copy), the PR title (clickable → `openPrUrl`, no
// separate link button/icon per the requirements doc), `#<number>`, and the
// branch. `GhPullRequest` doesn't carry a base-ref field (see
// shared/types.ts) — the doc explicitly allows "best-effort" here for 3a,
// so the arrow only renders when a base is available; today that's never,
// so it's just the branch chip alone until a future phase threads
// `baseRefName` through `getPrForBranch`. The existing worktree chip stays
// in the header row unchanged.
//
// Tab-strip growth: `[Diff | Commits]` becomes `[Diff | Commits | Details |
// Checks]` once `pr !== null` — Details/Checks are stubs this phase
// ("Coming soon" placeholders, same convention the Commits stub already
// uses); 3c/3d build their real content. No PR → the strip (and the rest of
// the tab) is completely unchanged from Phase 1/2.
//
// Phase 3b foundation (this pass) — the three-parallel-agent split. The
// Commits/Details/Checks sub-tabs are now their OWN files under ./git/
// (CommitsTab.tsx / DetailsTab.tsx / ChecksTab.tsx), each a self-contained
// placeholder receiving `{ prDetail, workspaceId, branch }` as props — so a
// later pass can build out each tab's real content in parallel, with each
// agent editing only its own file (no shared-file collision with GitTab.tsx
// or with each other). This component's only new responsibility is fetching
// the rich `github:prDetail` payload (src/shared/types.ts's
// GhPullRequestDetail — meta, labels, assignees, reviews, milestone,
// commits[], checks[], general comments) into `prDetail` state and handing it
// down: once on PR detection/change (the existing `onPrChanged` push below
// already tells us a PR now exists or changed), and again whenever the
// working-tree diff refetches (mirrors the existing refresh cadence rather
// than adding a second poll loop — the IPC itself is cached server-side for
// 5 minutes, so this doesn't hammer `gh`). `prDetail` resets to null exactly
// where `pr` resets to null (workspace switch, PR loss) so a stale previous
// workspace's/PR's rich data never leaks into the new one.
//
// Phase 4-pre — PR-diff mode (this pass): the prerequisite for Phase 4a's
// inline PR review comments, which anchor to the PR DIFF (branch vs base),
// not the working-tree diff this component has rendered since Phase 1. Adds
// a `diffMode: 'working' | 'pr'` state and a [Working tree | PR diff]
// segmented toggle (DiffModeToggle), shown only once `pr !== null` (no PR ->
// no toggle, tab stays exactly as before). Both modes feed the SAME
// DiffTreePane/DiffContentPane — `git:prDiff` (src/main/gitDiff.ts's
// getPrDiff) returns the identical `GitDiffResult` shape `git:diff` does, by
// reusing this module's own splitPatchByFile/fileFromChunk parsers server-
// side (gh pr diff emits the same `diff --git` format). Refresh cadence
// differs deliberately by mode: working-tree mode keeps its existing
// git:statusChanged/files:changed debounce; PR-diff mode refetches on mode
// switch and on `github:prChanged` (a PR diff is base...head against
// committed history — a working-tree file save has no bearing on it, so
// it's NOT wired to files:changed, per the task's explicit "avoid churn"
// direction). A PR disappearing (branch switch/close) while PR-diff mode is
// active falls back to working-tree mode, same fallback pattern the
// Details/Checks sub-tabs already use for PR loss.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelection } from '@pierre/trees/react'
import { themeToTreeStyles, type TreeThemeInput } from '@pierre/trees'
import { PatchDiff } from '@pierre/diffs/react'
import {
  List,
  Rows,
  Columns,
  MagnifyingGlass,
  GitBranch,
  CheckCircle,
  GitMerge,
  GitPullRequest,
  X
} from '@phosphor-icons/react'
import type {
  FileImage,
  GhPullRequest,
  GhPullRequestDetail,
  GhPullRequestState,
  GitDiffFile,
  GitStatusEntry
} from '@shared/types'
import { UI_STATE_DEFAULTS } from '@shared/uiStateDefaults'
import { Button } from '../Button'
import { useUiState, updateUiState } from '../../lib/uiStateStore'
import { openPrUrl } from '../../lib/overlayClient'
import { PIERRE_VIEWER_BG } from './editor/chromeTheme'
import { GitDiffOptionsPopover } from './GitDiffOptionsPopover'
import { useImageZoomPan } from './useImageZoomPan'
import { ImageZoomBar } from './ImageZoomBar'
import { CommitsTab } from './git/CommitsTab'
import { DetailsTab } from './git/DetailsTab'
import { ChecksTab } from './git/ChecksTab'

// Same minimal dark ThemeLike shape FilesTab uses for its tree — kept as its
// own const (rather than importing FilesTab's) so this component doesn't
// couple to FilesTab's module for a plain data literal; the visual result is
// identical (§5.1 recommends one shared theme, but a duplicated small object
// is cheap and keeps the two tabs independently editable).
const TREE_THEME: TreeThemeInput = {
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

// Git-status dot colors for the changed-files tree's shadow DOM — same
// GitHub-dark diff palette FilesTab uses (see its TREE_THEME hostStyle
// comment for the override-chain rationale).
const TREE_GIT_STATUS_VARS = {
  '--trees-padding-inline-override': '0px',
  '--trees-git-added-color-override': '#3fb950',
  '--trees-git-modified-color-override': '#d29922',
  '--trees-git-deleted-color-override': '#f85149',
  '--trees-git-renamed-color-override': '#58a6ff',
  '--trees-git-untracked-color-override': '#6e7681'
} as const

const VIEWER_THEME = { dark: 'pierre-dark', light: 'pierre-light' } as const

// Live-refresh debounce — coalesces bursts from either push source (a save
// touching several files, a `git add -A`) into one git:diff refetch.
//
// Perf fix (this pass): GitTab now drives filesWatcher.ts itself (see the
// watchStart/watchStop effect below), so a working-tree create/edit fires
// `files:changed` immediately instead of waiting on git.ts's much coarser
// `.git/HEAD`+`.git/index` watch. Tuned down from the original 200ms to
// 130ms now that the fast path is wired — still enough to coalesce a burst
// of files:changed events from a multi-file save/`git add -A` into one
// git:diff round-trip, without feeling laggy. The idempotent applyDiff
// no-op (see diffSignature below) is what keeps this safe at rest — a
// shorter debounce just means a REAL change reaches the screen sooner, it
// doesn't reintroduce the flicker loop that fix addressed.
const REFRESH_DEBOUNCE_MS = 130

export type DiffStyle = 'unified' | 'split'

/** Phase 4-pre — the Diff sub-tab's data-source mode: the uncommitted
 *  working-tree diff (default, unchanged from Phase 1) vs the full PR diff
 *  (base...head, via `gh pr diff`). See the module header's Phase 4-pre note. */
export type DiffMode = 'working' | 'pr'

export interface GitTabProps {
  /** The owning claude workspace's id — resolves to the workspace cwd in the
   *  main process (see src/main/gitDiff.ts via src/main/ipc/git.ts). */
  workspaceId: string
  /** Worktree metadata passed through from WorkspaceView/WorkbenchPanel (the
   *  app already tracks this per workspace) — drives the worktree/local chip
   *  below. Null worktreeParentCwd means this is a main-checkout workspace. */
  worktreeParentCwd: string | null
  worktreeBranch: string | null
}

/** Maps GitDiffFile[] into the GitStatusEntry[] shape @pierre/trees'
 *  `setGitStatus` expects (same enum FilesTab already feeds it — 'ignored' is
 *  simply never used here, every entry in a diff result is a real change). */
function toTreeGitStatus(files: readonly GitDiffFile[]): GitStatusEntry[] {
  return files.map((f) => ({ path: f.path, status: f.status }))
}

// Raster image extensions (Fix 4) — a changed binary file with one of these
// extensions renders as an <img> (via files:readImage) instead of a "no
// preview" placeholder. Kept as its own small const (not imported from
// FilesTab, which doesn't export its equivalent IMAGE_EXTENSIONS/isImagePath)
// — same "duplicated small literal, independently editable" rationale the
// module header already applies to TREE_THEME. SVG is deliberately excluded:
// it's XML/text source, so a changed .svg with actual hunks still renders as
// a normal text PatchDiff (only a truly binary .svg — rare — would fall
// through to the generic "Binary file" placeholder below).
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'])

function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return false
  return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase())
}

// --- Sub-tab strip -----------------------------------------------------------

type GitSubTab = 'diff' | 'commits' | 'details' | 'checks'

interface SubTabStripProps {
  active: GitSubTab
  onChange: (tab: GitSubTab) => void
  /** Phase 3a: the strip grows from [Diff|Commits] to [Diff|Commits|Details|
   *  Checks] once a PR is detected for the current branch — Details/Checks
   *  are PR-only surfaces (requirements doc's "Full-PR experience" tabs). */
  hasPr: boolean
}

/** [Diff | Commits] (or, with a PR, [Diff | Commits | Details | Checks])
 *  segmented control — matches FilesTab's ModeToggle visual language (compact
 *  pill segments) but no disabled state needed. Commits/Details/Checks all
 *  render stubs today (Phase 3b/3c/3d build them out). */
function SubTabStrip({ active, onChange, hasPr }: SubTabStripProps): React.JSX.Element {
  const seg = (value: GitSubTab, label: string): React.JSX.Element => (
    <button
      key={value}
      type="button"
      onClick={() => onChange(value)}
      aria-pressed={active === value}
      className={[
        'px-2 py-0.5 rounded text-[11px] font-medium transition-colors duration-100',
        active === value
          ? 'bg-surface-raised text-text-primary'
          : 'text-text-muted hover:text-text-secondary'
      ].join(' ')}
    >
      {label}
    </button>
  )
  return (
    <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-surface-overlay/60 border border-border-default/60">
      {seg('diff', 'Diff')}
      {seg('commits', 'Commits')}
      {hasPr && seg('details', 'Details')}
      {hasPr && seg('checks', 'Checks')}
    </div>
  )
}

// --- Diff-style icon toggle ---------------------------------------------------

interface DiffStyleToggleProps {
  value: DiffStyle
  onChange: (style: DiffStyle) => void
}

/** Unified/split icon toggle — Rows (stacked horizontal lines) for unified,
 *  Columns (two vertical columns) for split, matching the requirements doc's
 *  "SVG icon toggle, not text" cross-cutting rule. */
function DiffStyleToggle({ value, onChange }: DiffStyleToggleProps): React.JSX.Element {
  const btnClass = (active: boolean): string =>
    [
      'p-1 rounded',
      active
        ? 'bg-surface-raised text-text-primary'
        : 'text-text-muted hover:bg-surface-raised hover:text-text-primary'
    ].join(' ')
  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => onChange('unified')}
        aria-pressed={value === 'unified'}
        title="Unified diff"
        className={btnClass(value === 'unified')}
      >
        <Rows size={14} />
      </button>
      <button
        type="button"
        onClick={() => onChange('split')}
        aria-pressed={value === 'split'}
        title="Split diff"
        className={btnClass(value === 'split')}
      >
        <Columns size={14} />
      </button>
    </div>
  )
}

// --- Diff-mode segmented toggle (Phase 4-pre) --------------------------------

interface DiffModeToggleProps {
  value: DiffMode
  onChange: (mode: DiffMode) => void
}

/** [Working tree | PR diff] segmented control — only rendered by GitTab while
 *  a PR exists for the current branch (see the module header's Phase 4-pre
 *  note: PR review comments anchor to the PR diff, not the working-tree
 *  diff, so this toggle is the prerequisite for Phase 4a's inline comments).
 *  Matches SubTabStrip's compact pill-segment visual language rather than
 *  DiffStyleToggle's icon-only style — this needs readable labels, not icons,
 *  since "working tree" vs "PR diff" isn't obviously representable as a
 *  glyph pair. */
function DiffModeToggle({ value, onChange }: DiffModeToggleProps): React.JSX.Element {
  const seg = (mode: DiffMode, label: string): React.JSX.Element => (
    <button
      key={mode}
      type="button"
      onClick={() => onChange(mode)}
      aria-pressed={value === mode}
      className={[
        'px-2 py-0.5 rounded text-[11px] font-medium transition-colors duration-100',
        value === mode
          ? 'bg-surface-raised text-text-primary'
          : 'text-text-muted hover:text-text-secondary'
      ].join(' ')}
    >
      {label}
    </button>
  )
  return (
    <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-surface-overlay/60 border border-border-default/60">
      {seg('working', 'Working tree')}
      {seg('pr', 'PR diff')}
    </div>
  )
}

// --- Worktree/local chip ------------------------------------------------------

/** "worktree · <branch>" vs "local" — the app already tracks
 *  worktreeParentCwd/worktreeBranch per workspace (see WorkspaceTitleBar's
 *  own worktree chip), so this is pure presentation over props passed down
 *  from WorkspaceView, no new IPC needed. */
function WorktreeChip({
  worktreeParentCwd,
  worktreeBranch
}: {
  worktreeParentCwd: string | null
  worktreeBranch: string | null
}): React.JSX.Element {
  const isWorktree = worktreeParentCwd != null
  return (
    <span
      title={
        isWorktree
          ? `Worktree branch: ${worktreeBranch ?? 'unknown'}\nParent repo: ${worktreeParentCwd}`
          : 'Main checkout'
      }
      className="px-1.5 py-0.5 rounded text-[10px] font-medium text-text-muted bg-surface-overlay/60 border border-border-default/60 select-none whitespace-nowrap"
    >
      {isWorktree ? `worktree · ${worktreeBranch ?? '?'}` : 'local'}
    </span>
  )
}

// --- PR slim header (Phase 3a) ------------------------------------------------

// Badge color/label/icon per PR state — same vocabulary PrChip.tsx already
// established (github/PrChip.tsx's STATE_COLOR/STATE_LABEL) for the sidebar/
// kanban/title-bar chip. Duplicated here as small literals rather than
// imported: PrChip's own component renders its OWN compact pill shape
// (rounded-full pixel badge, tokenized bg colors) that doesn't match the
// mockup's `.pr-badge` (solid color chip, white text, pill icon+label) this
// header specifically asks for — see docs/brainstorms/git-tab-mockup's
// `renderPrHeader`. Same "duplicated small literal, independently editable"
// rationale the module already applies to TREE_THEME/IMAGE_EXTENSIONS.
const PR_BADGE_BG: Record<GhPullRequestState, string> = {
  open: 'bg-gh-open',
  draft: 'bg-gh-draft',
  merged: 'bg-gh-merged',
  closed: 'bg-gh-closed'
}

const PR_BADGE_LABEL: Record<GhPullRequestState, string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed'
}

function PrBadgeIcon({ state }: { state: GhPullRequestState }): React.JSX.Element {
  if (state === 'merged') return <GitMerge size={11} weight="fill" />
  if (state === 'closed') return <X size={11} weight="bold" />
  return <GitPullRequest size={11} weight={state === 'draft' ? 'regular' : 'fill'} />
}

/** Full-PR slim header (requirements doc's "Full-PR experience" → slim
 *  header; mockup's `.pr-header--slim`/`renderPrHeader`): status badge, a
 *  clickable title (→ `openPrUrl`, no separate link button per the doc),
 *  `#<number>`, and the current branch. Rendered ABOVE the existing tab
 *  header row, only while a PR is detected for this branch — `pr === null`
 *  (no PR / no `gh` / no remote / detached HEAD) means this never mounts and
 *  the rest of the tab is visually unchanged from Phase 1/2.
 *
 *  Base branch: `GhPullRequest` (shared/types.ts) has no base-ref field
 *  today, so — per the doc's "keep 3a simple: branch shown; base
 *  best-effort" — this only shows the head branch; a future pass can thread
 *  `baseRefName` through `getPrForBranch` and add the mockup's
 *  `branch → base` arrow here without changing this component's shape. */
function PrSlimHeader({
  pr,
  branch
}: {
  pr: GhPullRequest
  branch: string | null
}): React.JSX.Element {
  return (
    <div className="flex-shrink-0 px-3.5 py-2.5 border-b border-border-default bg-surface-raised">
      <div className="flex items-center gap-2">
        <span
          className={`flex-shrink-0 inline-flex items-center gap-1 text-[10.5px] font-bold px-1.5 py-0.5 rounded-full text-white tracking-wide ${PR_BADGE_BG[pr.state]}`}
        >
          <PrBadgeIcon state={pr.state} />
          {PR_BADGE_LABEL[pr.state]}
        </span>
        <div className="flex-1 min-w-0">
          <button
            type="button"
            onClick={() => openPrUrl(pr.url)}
            title="Open in browser"
            className="block w-full text-left text-[15px] font-semibold text-text-primary truncate cursor-pointer hover:underline"
          >
            {pr.title}
          </button>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-text-muted flex-wrap">
            <span>#{pr.number}</span>
            {branch !== null && (
              <span className="font-mono text-[11px] px-1.5 py-0 rounded bg-surface-overlay border border-border-default text-text-secondary">
                {branch}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// --- Changed-files tree pane ---------------------------------------------------

// Redesign (this pass, reversed per follow-up direction): the user first
// asked for a custom "+N -M" count decoration; then explicitly reversed that
// — drop the counts entirely and keep ONLY Pierre's own native git-status
// LETTER (the "U"/"M"/"A"/"D"/"R" the user actually wanted, "we had
// previously"). So this pane no longer injects any custom row content at
// all: no `renderRowDecoration`, no `unsafeCSS` lane styling, no "Binary"
// label. `setGitStatus(toTreeGitStatus(files))` below (already wired) is the
// ENTIRE mechanism — @pierre/trees renders that letter + a
// `data-item-git-status`-colored icon/row on its own
// (dist/render/FileTreeView.js's `getBuiltInGitStatusDecoration` /
// `GIT_STATUS_LABEL`), nothing else needed here. See git history on this
// file for the removed custom-decoration approach if it's ever revisited.
//
// The one unsafeCSS rule that DOES still need to be injected is unrelated to
// git-status rendering at all: it's Fix 2's search-icon-toggle visibility
// fix (see DiffTreeToolbar below) — @pierre/trees always mounts its
// `[data-file-tree-search-container]` box once `search: true` is passed,
// regardless of the controller's own isOpen state (same quirk FilesTab's
// TreePane works around), so this override keys the box's actual show/hide
// off the SAME `data-open` attribute the library stamps on it.
const SEARCH_BOX_VISIBILITY_CSS = `
  [data-file-tree-search-container][data-open="false"] {
    display: none;
  }
`

interface DiffTreePaneProps {
  files: readonly GitDiffFile[]
  selected: string | null
  onSelectFile: (path: string | null) => void
}

// Shared icon-button class for the changed-files tree's own header toolbar —
// matches FilesTab's TOOLBAR_BUTTON_CLASS exactly so it reads as the same
// chrome family.
const SEARCH_TOGGLE_BUTTON_CLASS =
  'p-1 rounded text-text-muted hover:bg-surface-raised hover:text-text-primary'

/** Compact header rendered into `<FileTree header={...} />`: just a
 *  search-toggle icon (Fix 2's changed-files search) — mirrors FilesTab's
 *  TreeToolbar, minus the New Folder/New File actions (a git diff's changed
 *  files aren't user-creatable). NOTE: this is CHANGED-FILES search only —
 *  the user also asked for "search in git commits", which belongs to the
 *  Commits sub-tab (a Phase-3 stub today, see SubTabStrip); commit search
 *  lands there, not here. */
function DiffTreeToolbar({
  searchOpen,
  onToggleSearch
}: {
  searchOpen: boolean
  onToggleSearch: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-center h-7 px-1">
      <button
        type="button"
        // Re-click-to-close fix (mirrors FilesTab's TreeToolbar — see its
        // comment): @pierre/trees' search `<input>` closes search on its own
        // blur by default, and a plain button click's mousedown fires BEFORE
        // its click, stealing focus from the still-open search input and
        // closing search synchronously — so onToggleSearch then reads a
        // stale "already closed" state and reopens it instead of leaving it
        // closed. Blocking the default mousedown action keeps focus on the
        // input so no blur-close race precedes onToggleSearch.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggleSearch}
        aria-pressed={searchOpen}
        title="Search changed files"
        className={SEARCH_TOGGLE_BUTTON_CLASS}
      >
        <MagnifyingGlass size={14} />
      </button>
    </div>
  )
}

/** Left pane: a flat @pierre/trees fed the changed files' paths + git-status
 *  decorations. Selecting a file reports it up to GitTab, which looks up its
 *  patch for the diff pane. No directories in this list beyond what the
 *  paths themselves imply — @pierre/trees derives the folder structure from
 *  the path separators, same as FilesTab.
 *
 *  FIX 1: `selected` (GitTab's own selectedPath — seeded by auto-select via
 *  nextSelection, or carried over from a prior render) is now pushed INTO the
 *  widget imperatively, mirroring FilesTab's store→tree restore (see its
 *  applyOptions comment + `model.getItem(restorePath)?.select()` /
 *  `scrollToPath`) — previously nothing ever called the model's own
 *  select(), so the widget's internal selection stayed empty and the
 *  selection-report effect below would fire with `[]`, reporting `null` up
 *  and clobbering GitTab's `selectedPath` back to null (the "Select a
 *  changed file" placeholder showing despite a populated auto-selection).
 *
 *  GUARD against the push/report ping-pong: the report effect below only
 *  ever propagates a NON-NULL widget selection upward (the same asymmetry
 *  FilesTab's restore-guard uses — withhold a clobbering `null` while a
 *  known-good selection hasn't been reflected into the widget yet). So an
 *  empty widget selection during (re)mount or a resetPaths() churn can never
 *  null out `selectedPath`; it can only be advanced by a genuine new
 *  non-null pick (a user click) or by this push effect explicitly selecting
 *  the auto-selected path once its path is actually present in the tree. */
function DiffTreePane({ files, selected, onSelectFile }: DiffTreePaneProps): React.JSX.Element {
  const paths = useMemo(() => files.map((f) => f.path), [files])

  const { model } = useFileTree({
    paths,
    initialExpansion: 'open',
    search: true,
    unsafeCSS: SEARCH_BOX_VISIBILITY_CSS
  })
  const selection = useFileTreeSelection(model)
  // Search-icon-toggle (Fix 2) — same visibility pattern FilesTab's TreePane
  // uses: `search: true` is required for the controller's search state to
  // exist at all, but the library always mounts the search box regardless of
  // `isOpen` (see FilesTab's SEARCH BOX VISIBILITY comment) — so `data-open`
  // is overridden via unsafeCSS below to actually hide/show it.
  const search = useFileTreeSearch(model)
  const toggleSearch = useCallback(() => {
    if (search.isOpen) search.close()
    else search.open()
  }, [search])

  // Push the fresh path list + git-status decorations into the tree whenever
  // the diff result changes — imperative, matching FilesTab's §7 pattern
  // (useFileTree only consumes its `paths` option at construction time).
  useEffect(() => {
    model.resetPaths(paths)
    model.setGitStatus(toTreeGitStatus(files))
  }, [model, paths, files])

  // FIX 1 (push half): whenever GitTab's `selected` path changes (or the
  // path set changes shape, e.g. after resetPaths above) AND the widget's
  // own current selection doesn't already match it, imperatively select it
  // in the widget — same call FilesTab's restore path uses
  // (`model.getItem(path)?.select()` + `scrollToPath`). Guarded so this
  // never fights the report effect below: it only acts when `selected` is
  // non-null and actually present in `paths` (nothing to select otherwise),
  // and it's a no-op once the widget selection already agrees, so it can't
  // re-trigger itself via the report effect on every tick.
  useEffect(() => {
    if (selected === null) return
    if (!paths.includes(selected)) return
    const current = selection.length === 1 ? selection[0] : null
    if (current === selected) return
    const item = model.getItem(selected)
    if (item == null) return
    item.select()
    model.scrollToPath(selected)
  }, [model, selected, paths, selection])

  // Report the single selected (non-directory) file up. Every path here is a
  // file already (git:diff never returns directories), so any single
  // selection is a valid target.
  //
  // FIX 1 (clobber guard): only ever propagate a NON-NULL widget selection.
  // Withholding a `null` report means an empty/transient widget selection —
  // during (re)mount, a resetPaths() churn, or the brief window before the
  // push effect above has run — can never stomp GitTab's already-populated
  // `selectedPath` back to null. A genuine user deselect never happens in
  // this single-select tree (there's no empty-space click target that
  // clears selection without picking another row), so this asymmetry costs
  // nothing real; it only removes the spurious clobber this fix addresses.
  useEffect(() => {
    const single = selection.length === 1 ? selection[0] : null
    if (single !== null && single !== selected) onSelectFile(single)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `selected`/`onSelectFile` intentionally excluded: this effect only reacts to the tree's OWN selection changing, not to GitTab re-deriving `selected` from a fresh files[] after a refetch.
  }, [selection])

  const toolbar = useMemo(
    () => <DiffTreeToolbar searchOpen={search.isOpen} onToggleSearch={toggleSearch} />,
    [search.isOpen, toggleSearch]
  )

  const hostStyle = useMemo(() => {
    const vars = themeToTreeStyles(TREE_THEME)
    return { height: '100%', ...vars, ...TREE_GIT_STATUS_VARS } as React.CSSProperties
  }, [])

  return (
    <div style={hostStyle} className="h-full">
      <FileTree model={model} header={toolbar} style={{ height: '100%' }} />
    </div>
  )
}

// --- Diff content pane ---------------------------------------------------------

interface DiffContentPaneProps {
  workspaceId: string
  file: GitDiffFile | null
  diffStyle: DiffStyle
  wrapLines: boolean
  loading: boolean
}

function DiffMessage({ text }: { text: string }): React.JSX.Element {
  return (
    <div
      className="flex-1 flex items-center justify-center min-h-0"
      style={{ backgroundColor: PIERRE_VIEWER_BG }}
    >
      <span className="text-xs text-text-muted select-none">{text}</span>
    </div>
  )
}

// --- Phase 2 edge states: not-a-repo (+ Git init) / clean ---------------------

/** Shared empty-state shell — centered icon + title + sub-line + optional
 *  action, matching the mockup's `.empty-state` (docs/brainstorms/
 *  git-tab-mockup/styles.css): centered column, muted 40px icon at 55%
 *  opacity, 13.5px title, 12px muted sub-line capped ~320px wide. Reuses
 *  PIERRE_VIEWER_BG so the edge states sit on the same dark viewer surface
 *  the diff pane itself uses, rather than introducing a third background. */
function EmptyStateShell({
  icon,
  title,
  subtitle,
  children
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className="flex-1 flex flex-col items-center justify-center gap-2.5 min-h-0 px-10 text-center"
      style={{ backgroundColor: PIERRE_VIEWER_BG }}
    >
      <div className="text-text-muted opacity-55">{icon}</div>
      <div className="text-[13.5px] font-semibold text-text-primary">{title}</div>
      <div className="text-xs text-text-muted max-w-[320px]">{subtitle}</div>
      {children}
    </div>
  )
}

/** State 1 (mockup) — `!repo`: this workspace's cwd isn't a git working tree
 *  at all. A primary "Git init" button runs `git:init`, then the caller
 *  refetches `git:diff` explicitly (a brand-new `.git` may not be picked up
 *  by the existing watchers immediately — see the module header). Inline
 *  status text stands in for a toast (the app has no global toast/notice
 *  mechanism to reuse — see the module header's Phase 2 note); the button is
 *  disabled while the init call is in flight. */
function NotARepoState({
  onInit,
  running,
  error
}: {
  onInit: () => void
  running: boolean
  error: string | null
}): React.JSX.Element {
  return (
    <EmptyStateShell
      icon={<GitBranch size={40} weight="regular" />}
      title="Not a git repository"
      subtitle="This workspace's folder isn't tracked by git yet. Initialize a repository here to start tracking changes."
    >
      <Button size="sm" onClick={onInit} loading={running} disabled={running}>
        <GitBranch size={14} />
        Git init
      </Button>
      {error !== null && <span className="text-xs text-red-400 max-w-[320px]">{error}</span>}
    </EmptyStateShell>
  )
}

/** State 2 (mockup) — `repo && files.length === 0`: a real repo with a clean
 *  working tree. `branch` comes from the existing `git:statusChanged` push
 *  GitTab already subscribes to for live-refresh (no new IPC round-trip) —
 *  it's `null` until that first push arrives (or on a branch-less/detached
 *  HEAD repo), in which case this falls back to the branch-less "No changes"
 *  copy rather than blocking the empty state on one. */
function CleanState({ branch }: { branch: string | null }): React.JSX.Element {
  const title = branch !== null ? `No changes on ${branch}` : 'No changes'
  return (
    <EmptyStateShell
      icon={<CheckCircle size={40} weight="regular" />}
      title={title}
      subtitle="The working tree is clean. Nothing to review yet."
    />
  )
}

/** Phase 4-pre — PR-diff mode's own empty state: `files.length === 0` while
 *  viewing PR diff means the fetch itself came back empty (no PR / no gh /
 *  network failure — see gitDiff.ts::getPrDiff's safety-net note; a PR that
 *  genuinely has zero changed files can't exist on GitHub). Distinct copy
 *  from CleanState's "working tree is clean" — that phrasing would be
 *  actively misleading here, since the PR diff has nothing to do with the
 *  working tree at all. */
function PrDiffEmptyState(): React.JSX.Element {
  return (
    <EmptyStateShell
      icon={<GitPullRequest size={40} weight="regular" />}
      title="No PR diff available"
      subtitle="Couldn't load the PR's diff right now. Try switching back to Working tree, or check that `gh` is authenticated."
    />
  )
}

// A settled files:readImage result, tagged with the path it belongs to —
// the same stale-guard shape FilesTab's LoadedImage uses, so a fast
// re-selection while a fetch is in flight can't commit a mismatched image.
interface LoadedGitImage {
  path: string
  image: FileImage
}

/** Fix 4 (image branch): fetches + renders the CURRENT on-disk image for a
 *  changed binary file whose extension is a recognized raster format, via
 *  the existing files:readImage IPC — the same one FilesTab's ImageBody
 *  uses. Showing the current/new version is the documented minimum (a
 *  before/after diff is a nice-to-have the task explicitly says to skip if
 *  non-trivial — it would need a second read of the file at HEAD, which
 *  files:readImage has no revision parameter for).
 *
 *  FIX 2: reuses FilesTab's zoom/pan exactly (useImageZoomPan + ImageZoomBar,
 *  see FilesTab.tsx's ImageBody) rather than reimplementing it — same
 *  `useImageZoomPan(path)` keyed on path so zoom/pan resets whenever the
 *  selected file changes, same pan-container wiring (wheel/pointer handlers
 *  + `zoom.style` transform + `zoom.cursorClassName`), same floating
 *  `<ImageZoomBar>`. The non-image "Binary file — no preview" placeholder in
 *  DiffContentPane is untouched — this only applies to the image branch. */
function BinaryImageBody({
  workspaceId,
  path
}: {
  workspaceId: string
  path: string
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<LoadedGitImage | null>(null)
  useEffect(() => {
    let cancelled = false
    window.api.files
      .readImage(workspaceId, path)
      .then((image) => {
        if (!cancelled) setLoaded({ path, image })
      })
      .catch((e) => {
        console.error('[GitTab] readImage failed:', e)
        if (!cancelled) setLoaded({ path, image: { ok: false, error: 'denied' } })
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, path])

  // Zoom/pan state resets whenever the viewed path changes — keyed on
  // `path` (not the loaded image), matching FilesTab's ImageBody comment on
  // why it's keyed on the SELECTION rather than the settled fetch.
  const zoom = useImageZoomPan(path)

  const current = loaded && loaded.path === path ? loaded.image : null
  if (current === null) return <DiffMessage text="Loading…" />
  if (!current.ok) {
    if (current.error === 'too-large') {
      return <DiffMessage text="Image too large to preview (over 5 MB)" />
    }
    return <DiffMessage text="Could not load image" />
  }
  return (
    <div
      className={`relative flex-1 min-h-0 flex items-center justify-center overflow-hidden ${zoom.cursorClassName}`}
      style={{ backgroundColor: PIERRE_VIEWER_BG }}
      onWheel={zoom.onWheel}
      onPointerDown={zoom.onPointerDown}
      onPointerMove={zoom.onPointerMove}
      onPointerUp={zoom.onPointerUp}
      onPointerCancel={zoom.onPointerUp}
    >
      <img
        src={current.dataUrl}
        alt=""
        draggable={false}
        className="max-w-full max-h-full object-contain"
        style={zoom.style}
      />
      <ImageZoomBar zoom={zoom} />
    </div>
  )
}

/** Right pane: the selected file's patch rendered via @pierre/diffs'
 *  <PatchDiff>, themed pierre-dark to match the Files-tab viewer, styled
 *  unified or split per the header toggle, word-wrapped per the ⚙ popover's
 *  Wrap-lines toggle. Empty/loading/no-selection states mirror FilesTab's
 *  ViewerMessage convention.
 *
 *  Fix 4: a `binary` file never reaches <PatchDiff> — its patch chunk is a
 *  `Binary files … differ` marker with no real hunks, which PatchDiff would
 *  render as a blank pane. Image extensions route to BinaryImageBody
 *  (current on-disk image via files:readImage); every other binary file
 *  gets a plain "no preview" placeholder. */
function DiffContentPane({
  workspaceId,
  file,
  diffStyle,
  wrapLines,
  loading
}: DiffContentPaneProps): React.JSX.Element {
  if (loading) return <DiffMessage text="Loading…" />
  if (file === null) return <DiffMessage text="Select a changed file to view its diff" />
  if (file.binary) {
    if (isImagePath(file.path)) {
      return <BinaryImageBody workspaceId={workspaceId} path={file.path} />
    }
    return <DiffMessage text="Binary file — no preview" />
  }
  return (
    <div className="flex-1 min-h-0 overflow-auto" style={{ backgroundColor: PIERRE_VIEWER_BG }}>
      <PatchDiff
        key={file.path}
        patch={file.patch}
        options={{
          theme: VIEWER_THEME,
          themeType: 'dark',
          diffStyle,
          overflow: wrapLines ? 'wrap' : 'scroll'
        }}
      />
    </div>
  )
}

// --- Root ------------------------------------------------------------------

/** Fix 1 — the auto-select rule applied every time a fresh `files[]` result
 *  settles (initial load, live-refresh refetch): keep the current selection
 *  if that path is STILL present in the new result (a refresh must not yank
 *  the user off the file they're looking at); otherwise fall back to the
 *  first changed file so the tab always shows a diff by default instead of
 *  the empty "Select a file" state. Returns null only when `files` itself is
 *  empty (a clean tree — nothing to select). Pure so it's trivially testable
 *  and keeps the effects below declarative. */
function nextSelection(files: readonly GitDiffFile[], current: string | null): string | null {
  if (current !== null && files.some((f) => f.path === current)) return current
  return files[0]?.path ?? null
}

/** A settled `git:diff` result, as GitTab needs it: the discriminator plus
 *  the files. Named separately from GitDiffResult so a network/IPC failure
 *  (caught below) can still produce a value of this shape — `repo: true`
 *  with an empty `files[]` is the deliberate "assume it's a repo, just
 *  couldn't read it right now" fallback, matching the old pre-Phase-2
 *  behavior of silently resolving to an empty diff on any failure. */
interface DiffSettleResult {
  repo: boolean
  files: GitDiffFile[]
}

// Loop-breaker (perf fix — see src/main/git.ts's statusSignature comment for
// the root cause): `git diff`/`git status` opportunistically rewrite
// `.git/index`'s stat-cache as a side effect of running them, which on some
// repos never "settles" — every read re-touches the index, re-firing the
// main-process watcher, pushing another `git:statusChanged`/`files:changed`
// event, scheduling another refetch, forever. src/main/git.ts now dedupes
// its OWN push on an unchanged status, which stops most of this at the
// source — but this signature is the renderer-side backstop: even if a
// refetch DOES fire (a real edit, a burst the main-process dedupe didn't
// catch, a future new event source), applying an IDENTICAL result is a
// no-op — no setFiles/setSelectedPath, so no re-render, no tree-flicker, no
// <PatchDiff> remount. A real change always produces a different signature
// (any changed patch text changes its own entry) and still applies. Patch
// TEXT (not just length) is included so a same-length content edit still
// counts as a change.
function diffSignature(result: DiffSettleResult): string {
  if (!result.repo) return 'no-repo'
  return result.files.map((f) => `${f.path} ${f.status} ${f.patch}`).join('')
}

/** Fetch the working-tree diff for `workspaceId`. Extracted so the debounced
 *  refetch effect below and the initial-load effect share one code path,
 *  keeping GitTab's own body under the cognitive-complexity ceiling. */
function fetchDiff(workspaceId: string, onSettled: (result: DiffSettleResult) => void): () => void {
  let cancelled = false
  window.api.git
    .diff(workspaceId)
    .then((result) => {
      if (!cancelled) onSettled({ repo: result.repo, files: result.files })
    })
    .catch((e) => {
      console.error('[GitTab] git:diff failed:', e)
      if (!cancelled) onSettled({ repo: true, files: [] })
    })
  return () => {
    cancelled = true
  }
}

/** Fetch the PR diff (Phase 4-pre) for `workspaceId` — same shape/contract as
 *  fetchDiff above, just backed by `git:prDiff` (gh pr diff <n>) instead of
 *  the working-tree `git:diff`. Kept as its own function (rather than a
 *  parameterized fetchDiff) so each mode's console-error label stays
 *  distinct and the mode-dispatch below reads as a plain if/else. */
function fetchPrDiff(
  workspaceId: string,
  onSettled: (result: DiffSettleResult) => void
): () => void {
  let cancelled = false
  window.api.git
    .prDiff(workspaceId)
    .then((result) => {
      if (!cancelled) onSettled({ repo: result.repo, files: result.files })
    })
    .catch((e) => {
      console.error('[GitTab] git:prDiff failed:', e)
      if (!cancelled) onSettled({ repo: true, files: [] })
    })
  return () => {
    cancelled = true
  }
}

/** Diff-mode dispatcher — the [Working tree | PR diff] toggle's data-source
 *  switch (Phase 4-pre). Both branches share the exact same
 *  fetch/cancel/onSettled contract, so every call site (initial load, mode
 *  switch, live-refresh) can stay mode-agnostic by just calling this. */
function fetchForMode(
  mode: DiffMode,
  workspaceId: string,
  onSettled: (result: DiffSettleResult) => void
): () => void {
  return mode === 'pr' ? fetchPrDiff(workspaceId, onSettled) : fetchDiff(workspaceId, onSettled)
}

/**
 * Workbench Git tab — Phase 1 body: a changed-files tree (left, collapsible)
 * and a per-file diff viewer (right). Mounted only while the Git tab is the
 * active, non-dormant Workbench tab (see WorkbenchPanel).
 */
export function GitTab({
  workspaceId,
  worktreeParentCwd,
  worktreeBranch
}: GitTabProps): React.JSX.Element {
  const [files, setFiles] = useState<GitDiffFile[]>([])
  // Phase 2: `repo` starts optimistic (`true`) so a first-paint flash of the
  // "Not a git repository" empty state doesn't show for an ordinary repo
  // while the initial git:diff round-trip is still in flight — `loading`
  // below already gates the tree/diff panes on the same round-trip, so this
  // mirrors that convention rather than introducing a third loading state.
  const [repo, setRepo] = useState(true)
  const [loading, setLoading] = useState(true)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [treeOpen, setTreeOpen] = useState(true)
  const [diffStyle, setDiffStyle] = useState<DiffStyle>('unified')
  // Phase 4-pre: the Diff sub-tab's data-source mode — 'working' (default,
  // unchanged Phase 1 behavior) or 'pr' (gh pr diff, gated on a PR existing —
  // see the module header's Phase 4-pre note). Reset to 'working' on every
  // workspace switch (below) so a PR-diff view never survives into a
  // different workspace that may have no PR at all.
  const [diffMode, setDiffMode] = useState<DiffMode>('working')
  const [subTab, setSubTab] = useState<GitSubTab>('diff')
  const [branch, setBranch] = useState<string | null>(null)
  const [gitInitRunning, setGitInitRunning] = useState(false)
  const [gitInitError, setGitInitError] = useState<string | null>(null)
  // Phase 3a: the PR for the current branch, or null (no PR / no `gh` / no
  // remote / detached HEAD). Populated entirely by the existing
  // `github:prChanged` push — see the module header's Phase 3a note for why
  // no separate fetch call is needed here.
  const [pr, setPr] = useState<GhPullRequest | null>(null)
  // Phase 3b foundation: the rich PR payload (GhPullRequestDetail) backing
  // the Commits/Details/Checks sub-tabs — see the module header's "Phase 3b
  // foundation" note. Null until fetched (or when there's no PR at all).
  const [prDetail, setPrDetail] = useState<GhPullRequestDetail | null>(null)

  // Fix 1: every settled `files[]` (initial load AND live-refresh refetch)
  // runs through nextSelection so the tab auto-selects the first changed
  // file when nothing is selected (or the prior selection dropped out),
  // while preserving an existing selection that's still present. Wraps
  // `setFiles`/`setRepo` so every call site below gets this for free, rather
  // than repeating the selection-derivation at each of the two settle points.
  //
  // Perf fix — idempotent by signature (see diffSignature's comment): a
  // settled result IDENTICAL to what's already applied is a no-op — skips
  // setRepo/setFiles/setSelectedPath entirely so `files`/the selected file
  // keep their EXISTING object identity across a redundant refetch (nothing
  // downstream re-renders or remounts). `lastAppliedSigRef` starts `null` so
  // the very first settle always applies (there's nothing to compare yet).
  const lastAppliedSigRef = useRef<string | null>(null)
  const applyDiff = useCallback((result: DiffSettleResult) => {
    const sig = diffSignature(result)
    if (sig === lastAppliedSigRef.current) return
    lastAppliedSigRef.current = sig
    setRepo(result.repo)
    setFiles(result.files)
    setSelectedPath((prev) => nextSelection(result.files, prev))
  }, [])

  // Phase 4-pre: tracks which `diffMode` was last fetched, so the mode-switch
  // effect (below the workspace-change effect) can tell "the user actually
  // flipped the toggle" apart from "diffMode just got reset to 'working' as
  // a side effect of a workspace switch" — see that effect's own comment for
  // why the distinction matters (double-fetch avoidance).
  const lastFetchedModeForWorkspaceRef = useRef<DiffMode>('working')

  // Initial load + workspace change. Resets files/selectedPath alongside
  // loading — otherwise DiffTreePane/DiffContentPane would briefly render the
  // PREVIOUS workspace's changed files/diff (loading=true but stale `files`)
  // until the new workspace's git:diff settles (CodeRabbit finding, fixed).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: a workspace switch must show "Loading…" (with no stale prior-workspace data) immediately rather than waiting; the settled result arrives asynchronously via fetchDiff's callback below.
    setLoading(true)
    setFiles([])
    setSelectedPath(null)
    setGitInitError(null)
    // A new workspace always starts back on the working-tree view — a
    // PR-diff selection from the PREVIOUS workspace has no guarantee the new
    // one even has a PR (see the module header's Phase 4-pre note); the
    // toggle itself won't render until this workspace's own PR-detection
    // settles, so falling back here keeps the state consistent with what's
    // visible.
    setDiffMode('working')
    // A new workspace starts with no known PR until its own
    // `github:prChanged` push arrives (see the subscription effect below) —
    // otherwise a switch from a PR'd workspace to a non-PR one would keep
    // showing the PREVIOUS workspace's slim header/tab-strip growth.
    setPr(null)
    // Same reset for the rich PR-detail payload (Phase 3b foundation) — a
    // new workspace's Commits/Details/Checks tabs must not render the
    // PREVIOUS workspace's PR data while the fresh prDetail fetch (below,
    // keyed off `pr`) is still in flight.
    setPrDetail(null)
    // A PR-only sub-tab (Details/Checks) carried over from the PREVIOUS
    // workspace has no backing strip segment here (hasPr is about to be
    // false until/unless this workspace's own PR push says otherwise) —
    // fall back to Diff. Mirrors the same fallback the onPrChanged(null)
    // path below applies for an in-place PR-loss on the SAME workspace;
    // this covers the workspace-switch case that push wouldn't necessarily
    // fire for (CodeRabbit finding, fixed).
    setSubTab((prev) => (prev === 'details' || prev === 'checks' ? 'diff' : prev))
    // A new workspace has nothing in common with whatever signature the
    // PREVIOUS workspace last applied — reset so applyDiff can't mistake a
    // coincidentally-identical result (e.g. two different clean repos both
    // signature to the same "no changes" value) for a no-op and skip
    // applying the new workspace's (already correct, just-reset-above)
    // state. Purely a correctness/future-proofing reset; harmless either way
    // since files/selectedPath were already reset directly above.
    lastAppliedSigRef.current = null
    // Guards the mode-switch effect below from re-firing its own redundant
    // fetch for this same workspace-change tick — see that effect's comment.
    lastFetchedModeForWorkspaceRef.current = 'working'
    return fetchDiff(workspaceId, (result) => {
      applyDiff(result)
      setLoading(false)
    })
  }, [workspaceId, applyDiff])

  // Phase 4-pre: refetch whenever the [Working tree | PR diff] toggle
  // switches mode. Deliberately its own effect (not folded into the
  // workspace-change effect above) so switching modes on the SAME workspace
  // doesn't also reset pr/prDetail/subTab — only the diff data itself needs
  // to change.
  //
  // `lastFetchedModeForWorkspaceRef` guards against a redundant duplicate
  // fetch: the workspace-change effect above already fetches 'working' mode
  // (and resets `diffMode` to 'working') as part of handling a workspace
  // switch, so without this guard, EVERY workspace switch would ALSO trigger
  // this effect (since `diffMode` may be transitioning pr -> working) and
  // fire a second, redundant git:diff round-trip. The guard tracks which
  // mode was last fetched for the CURRENT workspace/mode pair and skips a
  // repeat.
  useEffect(() => {
    if (lastFetchedModeForWorkspaceRef.current === diffMode) return undefined
    lastFetchedModeForWorkspaceRef.current = diffMode
    // Intentional: switching modes must show "Loading…" (with no stale
    // prior-mode data) immediately; the settled result arrives asynchronously
    // via fetchForMode's callback below. (No eslint-disable needed here — the
    // early-return guard above means this isn't the unconditional
    // top-of-effect setState the react-hooks/set-state-in-effect rule flags.)
    setLoading(true)
    setFiles([])
    setSelectedPath(null)
    lastAppliedSigRef.current = null
    return fetchForMode(diffMode, workspaceId, (result) => {
      applyDiff(result)
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- workspaceId intentionally excluded: this effect's guard already re-derives correctly on a workspace change (the workspace-change effect above sets the ref to 'working' in the same tick it resets diffMode to 'working', so this effect sees a no-op match and skips, exactly as intended).
  }, [diffMode])

  // Working-tree watcher (src/main/filesWatcher.ts) — see the module header's
  // PERF FIX note. Mirrors FilesTab.tsx's own watchStart/watchStop effect
  // exactly: start the main-process watch on mount (or workspaceId change),
  // stop it on unmount, same .catch-only error handling (a failed
  // start/stop here just means live-refresh degrades to the git.ts-only
  // signal, not a crash). GitTab is only ever mounted while it's the active
  // Workbench tab (see the module header's Gating note), so this start/stop
  // is exactly scoped to "while the Git tab is showing" — same lifecycle
  // FilesTab uses for "while the Files tab is showing". The two tabs being
  // mutually exclusive is what makes both safely calling watchStart/watchStop
  // non-conflicting: at most one of them is ever mounted at a time, so at
  // most one of them ever holds filesWatcher's single-active slot.
  useEffect(() => {
    window.api.files
      .watchStart(workspaceId)
      .catch((e) => console.error('[GitTab] watchStart failed:', e))
    return () => {
      window.api.files
        .watchStop(workspaceId)
        .catch((e) => console.error('[GitTab] watchStop failed:', e))
    }
  }, [workspaceId])

  // Live refresh: git:statusChanged (branch/index change — src/main/git.ts's
  // .git watcher, already running unconditionally since terminal:mount) and
  // files:changed (working-tree edits — filesWatcher.ts, now driven by THIS
  // tab via the watchStart/watchStop effect above) both indicate the working
  // TREE may have moved; refetch git:diff, debounced so a burst of either
  // collapses into one round-trip.
  //
  // Phase 4-pre: deliberately WORKING-TREE-ONLY. A PR diff is `base...head`
  // against already-committed history — neither a working-tree file save nor
  // the local index changing has any bearing on it (see the module header's
  // Phase 4-pre note: "don't wire PR-diff to files:changed, avoid churn").
  // `diffModeRef` (kept in sync below, same "latest value without an effect
  // dependency" pattern the existing `prRef` below uses) lets this callback
  // check the CURRENT mode without resubscribing/restarting the debounce
  // timer on every toggle flip.
  const diffModeRef = useRef(diffMode)
  useEffect(() => {
    diffModeRef.current = diffMode
  }, [diffMode])
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    const scheduleRefetch = (): void => {
      if (diffModeRef.current !== 'working') return
      if (debounceRef.current !== null) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null
        cleanupRef.current?.()
        cleanupRef.current = fetchDiff(workspaceId, applyDiff)
      }, REFRESH_DEBOUNCE_MS)
    }
    const unsubStatus = window.api.git.onStatusChanged((e) => {
      if (e.workspaceId === workspaceId) {
        setBranch(e.status.branch)
        scheduleRefetch()
      }
    })
    const unsubFiles = window.api.files.onFilesChanged((e) => {
      if (e.workspaceId === workspaceId) scheduleRefetch()
    })
    return () => {
      unsubStatus()
      unsubFiles()
      if (debounceRef.current !== null) clearTimeout(debounceRef.current)
      cleanupRef.current?.()
      cleanupRef.current = null
    }
  }, [workspaceId, applyDiff])

  // Phase 3a: PR detection. `startGitWatch` (src/main/git.ts, running
  // unconditionally since terminal:mount) already resolves the current
  // branch's PR and pushes it over `github:prChanged` — once on initial
  // watch registration and again on every branch change — so this is a pure
  // subscribe, no fetch call of its own. Filtered to this workspace the same
  // way the git:statusChanged/files:changed subscriptions above are.
  useEffect(() => {
    return window.api.github.onPrChanged((e) => {
      if (e.workspaceId !== workspaceId) return
      setPr(e.pr)
      // If the PR just disappeared (branch switched to one with no PR, or
      // the PR was closed/deleted) while a PR-only sub-tab (Details/Checks)
      // was active, the strip segment backing it is about to unmount out
      // from under the user — fall back to Diff rather than leaving
      // `subTab` pointed at a segment that no longer exists in the strip.
      // Done here (inside the external-event callback) rather than a
      // separate effect keyed on `pr`/`subTab`, since setState directly in
      // an effect body — as opposed to an event-driven callback like this
      // one — is a lint error (cascading-render risk).
      if (e.pr === null) {
        setSubTab((prev) => (prev === 'details' || prev === 'checks' ? 'diff' : prev))
        // Same "clear immediately rather than wait on a round-trip" reset
        // for the rich PR-detail payload (Phase 3b foundation) — done here
        // (inside this event callback) rather than in the prDetail-fetch
        // effect below, for the same cascading-render reason noted above.
        setPrDetail(null)
        // Phase 4-pre: the PR-diff toggle is about to unmount out from under
        // the user for the same reason the Details/Checks tabs are above —
        // fall back to the working-tree view rather than leaving `diffMode`
        // pointed at 'pr' with no PR left to diff against. The mode-switch
        // effect (which owns fetching) reacts to this state change on its
        // own; no fetch call needed here.
        setDiffMode((prev) => (prev === 'pr' ? 'working' : prev))
      } else if (diffModeRef.current === 'pr') {
        // Phase 4-pre: the PR changed (branch switch to a DIFFERENT PR'd
        // branch, or the same PR updated) while already viewing PR-diff mode
        // — refetch so the pane reflects the new/updated PR rather than the
        // previous one's stale diff. The mode-switch effect's own `diffMode`
        // dependency won't re-fire here (the mode itself didn't change), so
        // this is the one place that needs an explicit refetch call for this
        // case.
        cleanupRef.current?.()
        cleanupRef.current = fetchPrDiff(workspaceId, applyDiff)
      }
    })
  }, [workspaceId, applyDiff])

  // Phase 3b foundation: fetch the rich `github:prDetail` payload backing the
  // Commits/Details/Checks sub-tabs (see the module header's "Phase 3b
  // foundation" note) whenever a PR exists for this workspace/branch —
  // re-runs on `pr.number`/`pr.state` change (a new/updated PR, e.g. after a
  // branch switch or a merge/close) rather than on the whole `pr` object
  // reference, since `onPrChanged` above may push an equivalent-but-new
  // object on every branch-watch tick. The `pr === null` case needs no work
  // here at all — `prDetail` is already cleared synchronously wherever `pr`
  // itself is cleared (the workspace-switch reset above, and the
  // onPrChanged(null) branch above), so this effect simply has nothing to
  // fetch and skips straight to a no-op cleanup (avoids a setState-in-effect
  // lint error from clearing it a second time here).
  useEffect(() => {
    if (pr === null) return undefined
    let cancelled = false
    window.api.github
      .prDetail(workspaceId)
      .then((detail) => {
        if (!cancelled) setPrDetail(detail)
      })
      .catch((e) => {
        console.error('[GitTab] github:prDetail failed:', e)
        if (!cancelled) setPrDetail(null)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed on the PRIMITIVE pr?.number/pr?.state rather than the whole `pr` object: onPrChanged (above) may push a referentially-new-but-equal PR on every branch-watch tick, and this effect must not refetch prDetail on those no-op pushes.
  }, [workspaceId, pr?.number, pr?.state])

  // Phase 3b foundation: also refresh `prDetail` whenever the working-tree
  // diff itself refetches (the existing git:statusChanged/files:changed
  // live-refresh effect above) — mirrors the diff's own refresh cadence
  // rather than adding a second poll loop, and picks up e.g. new commits
  // pushed to the PR branch, new checks landing, or new reviews without
  // requiring a branch change. Subscribes unconditionally (cheap — just an
  // event listener) and checks `pr` freshly inside the callback via a ref
  // (kept in sync by its own effect below, never written during render) so
  // this doesn't need `pr` in its own dependency array — avoids a
  // resubscribe on every PR poll tick, same "latest value without an effect
  // dependency" escape hatch as elsewhere in this file.
  const prRef = useRef(pr)
  useEffect(() => {
    prRef.current = pr
  }, [pr])
  useEffect(() => {
    return window.api.git.onStatusChanged((e) => {
      if (e.workspaceId !== workspaceId) return
      if (prRef.current === null) return
      window.api.github
        .prDetail(workspaceId)
        .then(setPrDetail)
        .catch((e2) => console.error('[GitTab] github:prDetail refresh failed:', e2))
    })
  }, [workspaceId])

  // Phase 2 Git-init: runs git:init, then — regardless of outcome — clears
  // the running flag; on success, explicitly refetches git:diff (a brand-new
  // `.git` dir may not be picked up by the existing watchers immediately, so
  // this doesn't rely on live-refresh) which naturally moves the tab into
  // the clean-state render branch once `repo` flips true with empty `files`.
  const runGitInit = useCallback(() => {
    setGitInitRunning(true)
    setGitInitError(null)
    window.api.git
      .init(workspaceId)
      .then((result) => {
        if (result.ok) {
          cleanupRef.current?.()
          cleanupRef.current = fetchDiff(workspaceId, applyDiff)
        } else {
          setGitInitError(result.error)
        }
      })
      .catch((e) => {
        console.error('[GitTab] git:init failed:', e)
        setGitInitError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        setGitInitRunning(false)
      })
  }, [workspaceId, applyDiff])

  // If the currently-selected file drops out of the diff (e.g. the user
  // committed/discarded it externally), `selectedFile` below simply derives
  // to null — no separate effect needed to "clear" `selectedPath` itself;
  // DiffContentPane already renders the no-selection message for a null
  // file, and if the same path reappears later selection re-resolves
  // naturally from the same derivation.
  const selectedFile = useMemo(
    () => files.find((f) => f.path === selectedPath) ?? null,
    [files, selectedPath]
  )

  const toggleTree = useCallback(() => setTreeOpen((v) => !v), [])

  // Fix 2: the ⚙ diff-options popover's Wrap-lines toggle — APP-WIDE view
  // preference, persisted via AppUiState.gitDiffWrapLines (same
  // files_wrap_lines pattern FilesTab's TreeOptionsPopover uses). Falls back
  // to UI_STATE_DEFAULTS while the initial uiState.get() hasn't resolved yet.
  const uiState = useUiState()
  const wrapLines = uiState?.gitDiffWrapLines ?? UI_STATE_DEFAULTS.gitDiffWrapLines
  const diffOptions = useMemo(() => ({ wrapLines }), [wrapLines])
  const setDiffOptions = useCallback((next: { wrapLines: boolean }) => {
    updateUiState({ gitDiffWrapLines: next.wrapLines })
  }, [])

  // Phase 2: the hide-tree icon + unified/split toggle + ⚙ wrap popover only
  // make sense once there's an actual diff to view — while loading, or in
  // either edge state (not-a-repo / clean), there's no tree/diff pane to
  // control. The worktree chip + [Diff|Commits] strip stay visible in every
  // state (matching the mockup's edge-states panel, which keeps its own
  // harness chrome up top regardless of body state).
  const showDiffControls = !loading && repo && files.length > 0

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col">
      {pr !== null && <PrSlimHeader pr={pr} branch={branch} />}
      <div className="h-8 flex-shrink-0 border-b border-border-default flex items-center px-1 gap-1">
        {showDiffControls && (
          <>
            <button
              type="button"
              onClick={toggleTree}
              aria-pressed={treeOpen}
              aria-label={treeOpen ? 'Hide changed-files tree' : 'Show changed-files tree'}
              title={treeOpen ? 'Hide changed-files tree' : 'Show changed-files tree'}
              className="p-1 rounded text-text-muted hover:bg-surface-raised hover:text-text-primary"
            >
              <List size={16} />
            </button>
            <DiffStyleToggle value={diffStyle} onChange={setDiffStyle} />
            <GitDiffOptionsPopover options={diffOptions} onChange={setDiffOptions} />
          </>
        )}
        {
          // Phase 4-pre: the [Working tree | PR diff] toggle — shown only
          // while the Diff sub-tab is active AND a PR exists for this branch
          // (see the module header's Phase 4-pre note: PR-diff mode has
          // nothing to show without a PR to diff against, so no PR means no
          // toggle and the tab stays working-tree-only, unchanged from
          // Phase 1/2/3). Independent of `showDiffControls` (loading/edge
          // states) so the toggle doesn't pop in/out as the working tree's
          // OWN load state flickers — it only tracks PR existence.
          pr !== null && subTab === 'diff' && (
            <DiffModeToggle value={diffMode} onChange={setDiffMode} />
          )
        }
        <div className="ml-auto flex items-center gap-2">
          <WorktreeChip worktreeParentCwd={worktreeParentCwd} worktreeBranch={worktreeBranch} />
          <SubTabStrip active={subTab} onChange={setSubTab} hasPr={pr !== null} />
        </div>
      </div>
      {subTab === 'commits' && (
        <CommitsTab prDetail={prDetail} workspaceId={workspaceId} branch={branch} />
      )}
      {subTab === 'details' && (
        <DetailsTab prDetail={prDetail} workspaceId={workspaceId} branch={branch} />
      )}
      {subTab === 'checks' && (
        <ChecksTab prDetail={prDetail} workspaceId={workspaceId} branch={branch} />
      )}
      {subTab === 'diff' && (
        <GitTabBody
          loading={loading}
          repo={repo}
          files={files}
          selectedPath={selectedPath}
          selectedFile={selectedFile}
          treeOpen={treeOpen}
          diffStyle={diffStyle}
          wrapLines={wrapLines}
          workspaceId={workspaceId}
          branch={branch}
          gitInitRunning={gitInitRunning}
          gitInitError={gitInitError}
          diffMode={diffMode}
          onSelectFile={setSelectedPath}
          onGitInit={runGitInit}
        />
      )}
    </div>
  )
}

interface GitTabBodyProps {
  loading: boolean
  repo: boolean
  files: GitDiffFile[]
  selectedPath: string | null
  selectedFile: GitDiffFile | null
  treeOpen: boolean
  diffStyle: DiffStyle
  wrapLines: boolean
  workspaceId: string
  branch: string | null
  gitInitRunning: boolean
  gitInitError: string | null
  /** Phase 4-pre — which empty state to render for `files.length === 0`:
   *  'working' keeps the existing not-a-repo/clean-tree branches; 'pr' shows
   *  PrDiffEmptyState instead (a PR-diff fetch has no "not a repo"/"clean
   *  tree" concept of its own — see that component's doc comment). */
  diffMode: DiffMode
  onSelectFile: (path: string | null) => void
  onGitInit: () => void
}

/** The Diff sub-tab's body — extracted from GitTab's own render so the
 *  three-way branch (loading / not-a-repo / clean / has-changes) reads as a
 *  flat set of early returns instead of nested ternaries inline in GitTab's
 *  JSX, keeping GitTab's own cognitive complexity down. `loading` intentionally
 *  takes priority over `repo`/`files` — see GitTab's `repo` state comment on
 *  why it defaults optimistic. */
function GitTabBody({
  loading,
  repo,
  files,
  selectedPath,
  selectedFile,
  treeOpen,
  diffStyle,
  wrapLines,
  workspaceId,
  branch,
  gitInitRunning,
  gitInitError,
  diffMode,
  onSelectFile,
  onGitInit
}: GitTabBodyProps): React.JSX.Element {
  if (loading) return <DiffMessage text="Loading…" />
  if (diffMode === 'pr') {
    if (files.length === 0) return <PrDiffEmptyState />
  } else {
    if (!repo) {
      return <NotARepoState onInit={onGitInit} running={gitInitRunning} error={gitInitError} />
    }
    if (files.length === 0) return <CleanState branch={branch} />
  }

  return (
    <div className="flex-1 min-h-0 flex">
      <div hidden={!treeOpen} className="w-60 flex-shrink-0 min-h-0 border-r border-border-default">
        <DiffTreePane files={files} selected={selectedPath} onSelectFile={onSelectFile} />
      </div>
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        <DiffContentPane
          workspaceId={workspaceId}
          file={selectedFile}
          diffStyle={diffStyle}
          wrapLines={wrapLines}
          loading={false}
        />
      </div>
    </div>
  )
}
