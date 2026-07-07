// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/diff/DiffContentPane.tsx
//
// GitTab's right-hand diff-content pane — extracted verbatim from GitTab.tsx
// (Wave 3 Phase A structural extraction). Renders the selected file's patch
// via @pierre/diffs' <PatchDiff> (themed pierre-dark, unified/split per the
// header toggle, word-wrapped per the ⚙ popover), plus the binary-image,
// oversized-diff, and merge-conflict special-case branches.
//
// DiffMessage — shared centered-message viewer state (loading/no-selection/
// binary placeholder text).
// OversizedDiffPlaceholder — Crash fix #1's safety net above the (raised)
// oversized-file cap.
// BinaryImageBody — Fix 4's image branch (current on-disk image via
// files:readImage), reusing FilesTab's zoom/pan.
// anchorFromRange/buildDiffOptions — the <PatchDiff> options builder + the
// select-a-range-to-comment anchor resolver (Phase 4b).
// countConflictRegions/ConflictDiffPane — Pierre adoption batch 4's
// read-only merge-conflict viewer branch (<UnresolvedFile>).
// ReviewComposerWiring — the subset of useReviewComposers' result this pane
// needs, plus the submit callback.
// DiffPaneErrorBoundary — crash fix (React #185 "Show anyway" investigation):
// a diff-pane-local error boundary so a future @pierre/diffs render throw
// degrades to an inline message instead of tearing down the whole workspace
// view via the app-level boundary.
// DiffContentPane (memoized) — the exported pane itself.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState, memo, Component } from 'react'
import type React from 'react'
import { PatchDiff, UnresolvedFile, Virtualizer } from '@pierre/diffs/react'
import { MERGE_CONFLICT_START_MARKER_REGEX } from '@pierre/diffs'
import type { FileDiffOptions, SelectedLineRange } from '@pierre/diffs'
import { GitMerge } from '@phosphor-icons/react'
import type {
  FileContents as GitFileContents,
  FileImage,
  GhReviewCommentThread,
  GitDiffFile,
  LocalReviewComment
} from '@shared/types'
import { PIERRE_VIEWER_BG } from '../../editor/chromeTheme'
import { useImageZoomPan } from '../../useImageZoomPan'
import { ImageZoomBar } from '../../ImageZoomBar'
import type { DiffStyle } from '../../GitTab'
import type { CommentDraft, GhSubmitResult } from '../CommentComposer'
import type { PendingComposer } from '../useReviewComposers'
import type { UseTokenHoverPopoverResult } from '../useTokenHoverPopover'
import {
  annotationsForFile,
  type LocalCommentWiring,
  type ReviewAnnotationMeta
} from './reviewAnnotations'
import { renderReviewCommentAnnotation } from './renderReviewCommentAnnotation'
import { GutterAddCommentButton } from './GutterAddCommentButton'

const VIEWER_THEME = { dark: 'pierre-dark', light: 'pierre-light' } as const

// Crash fix #2 (belt-and-suspenders) — see buildDiffOptions' doc comment.
const DIFF_TOKENIZE_MAX_LINE_LENGTH = 1000

// Pierre-adoption Batch 1a — whole-diff byte cap (distinct from the per-LINE
// cap above). BaseCodeOptions.tokenizeMaxLength (confirmed in
// node_modules/@pierre/diffs/dist/types.d.ts:300) bounds the TOTAL bytes
// Pierre will tokenize with Shiki before falling back to plain (uncoloured)
// text for the rest — belt-and-suspenders alongside the OversizedDiffPlaceholder
// gate above `buildDiffOptions`' caller: that gate keeps genuinely huge patches
// out of <PatchDiff> entirely, while this handles the mid-size case (a
// large-but-ordinary-line-length file that's under the placeholder's
// byte/line thresholds but would still be a heavy synchronous tokenize pass).
// Pierre's own default (DEFAULT_TOKENIZE_MAX_LENGTH, dist/constants.js) is
// 100_000 bytes; 750_000 gives real-world diffs (a few thousand lines) full
// highlighting while still bailing out gracefully to plaintext well before
// the OversizedDiffPlaceholder's own much larger hard cap.
const DIFF_TOKENIZE_MAX_LENGTH = 750_000

// Raster image extensions (Fix 4) — a changed binary file with one of these
// extensions renders as an <img> (via files:readImage) instead of a "no
// preview" placeholder. Kept as its own small const (not imported from
// FilesTab, which doesn't export its equivalent IMAGE_EXTENSIONS/isImagePath)
// — same "duplicated small literal, independently editable" rationale the
// module already applies to TREE_THEME in treeConfig.ts. SVG is deliberately
// excluded: it's XML/text source, so a changed .svg with actual hunks still
// renders as a normal text PatchDiff (only a truly binary .svg — rare — would
// fall through to the generic "Binary file" placeholder below).
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'])

function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return false
  return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase())
}

export function DiffMessage({ text }: { text: string }): React.JSX.Element {
  return (
    <div
      className="flex-1 flex items-center justify-center min-h-0"
      style={{ backgroundColor: PIERRE_VIEWER_BG }}
    >
      <span className="text-xs text-text-muted select-none">{text}</span>
    </div>
  )
}

/** Crash fix #1 — the default view for a `file.oversized` diff: a lightweight
 *  placeholder instead of feeding the full patch into <PatchDiff>. Pierre
 *  adoption batch 2a wraps the diff pane in <Virtualizer>, so <PatchDiff>
 *  now renders windowed (VirtualizedFileDiff) — only ~visible rows hit
 *  shadow-DOM — which is why gitDiff.ts's OVERSIZED_LINE_THRESHOLD/
 *  OVERSIZED_BYTE_THRESHOLD were raised substantially rather than removed:
 *  Shiki still tokenizes the whole patch text synchronously on the main
 *  thread (virtualization windows the DOM, not the tokenize pass — that's
 *  the separate off-main-thread worker-pool batch), so an astronomically
 *  large patch can still stall/crash the renderer. This placeholder is kept
 *  as the ultimate safety net above the new (much higher) cap. `N lines`
 *  uses `additions + deletions` — already computed server-side from the
 *  full chunk, so this needs no client-side re-scan of the patch text.
 *  "Show anyway" hands control back to the caller for power users who want
 *  to pay the cost knowingly. */
function OversizedDiffPlaceholder({
  lineCount,
  onShowAnyway
}: {
  lineCount: number
  onShowAnyway: () => void
}): React.JSX.Element {
  return (
    <div
      className="flex-1 flex flex-col items-center justify-center min-h-0 gap-2"
      style={{ backgroundColor: PIERRE_VIEWER_BG }}
    >
      <span className="text-xs text-text-muted select-none">
        Large diff hidden — {lineCount.toLocaleString()} lines
      </span>
      <button
        type="button"
        onClick={onShowAnyway}
        className="text-xs text-accent hover:underline select-none"
      >
        Show anyway
      </button>
    </div>
  )
}

/** CRASH FIX (React #185 / "Maximum update depth exceeded" — the "Show
 *  anyway" crash): a very large PR falls back to GitHub's REST "list PR
 *  files" API (gitDiff.ts's `getPrDiff` tier 2), and that API declines to
 *  return `patch` text at all for a handful of files per PR (large generated
 *  files — observed on this repo's own PR #117: gitDiff.ts itself, plus
 *  several `src/shared/*` files touched only cosmetically). `apiFileWithoutPatch`
 *  (gitDiff.ts) marks those `oversized: true` with real additions/deletions
 *  but `patch: ''` — a genuinely empty string, not a small-but-real patch.
 *
 *  Before this fix, "Show anyway" on such a file unconditionally rendered
 *  `<PatchDiff patch={''}>`. @pierre/diffs' `getSingularPatch` (called from
 *  `PatchDiff`'s own `usePatch` -> `useMemo`) parses the patch and THROWS
 *  ("FileDiff: Provided patch must contain exactly 1 file diff") the instant
 *  it doesn't resolve to exactly one file's hunks — verified live via CDP:
 *  clicking "Show anyway" on `gitDiff.ts` (PR #117, patch: '') threw exactly
 *  that error out of a `useMemo` during render, with no error boundary
 *  local to the diff pane to catch it — it propagated to the app-level
 *  boundary, tearing down the whole workspace view (`terminal.hide`), which
 *  is what surfaces to the user/diagnostics as React error #185 (React's
 *  render-phase throw recovery repeatedly re-invoking the failing render
 *  before the boundary gives up).
 *
 *  Fix: detect a patch with no real diff content (empty/whitespace-only, or
 *  missing every marker @pierre/diffs' own parser requires to recognize a
 *  file — a `diff --git`/`Index:`/`---`+`+++` header pair) BEFORE ever
 *  constructing <PatchDiff>, and render a plain "not available" message
 *  instead. This is checked both in the oversized-placeholder branch (so
 *  "Show anyway" for a patch-less oversized file shows the graceful message
 *  rather than a button that crashes when clicked) and, as defense in depth,
 *  on the normal (non-oversized) render path — a non-oversized file should
 *  never have an empty patch in practice (fileFromChunk always derives
 *  `patch` from a real chunk), but guarding both call sites means a future
 *  diff-source change can't reopen this exact crash by constructing a
 *  `GitDiffFile` with a blank patch outside the oversized path. */
function hasRenderablePatch(patch: string): boolean {
  const trimmed = patch.trim()
  if (trimmed.length === 0) return false
  return (
    trimmed.includes('diff --git ') ||
    trimmed.startsWith('Index: ') ||
    (trimmed.includes('\n--- ') && trimmed.includes('\n+++ ')) ||
    (trimmed.startsWith('--- ') && trimmed.includes('\n+++ '))
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

/** Phase 4b — converts a Pierre `SelectedLineRange` (from `onLineSelected`'s
 *  select-a-range gesture) into the anchor a pending composer opens at: the
 *  range's END line/side (matches GitHub's own "comment on lines X-Y" UX,
 *  which anchors the thread to the last line of the range) — the anchor
 *  itself is always a single line/side pair, never a range, matching
 *  GitHub's server-side `start_line`/`line` split (the anchor IS `line`).
 *
 *  Pierre adoption Batch 3: a true multi-line selection is no longer thrown
 *  away — this function's own job stays scoped to anchor computation only
 *  (still returns just `{line, side}`), but ITS CALLER now also reads
 *  `range.start` directly (when `range.start !== range.end`) and threads it
 *  through `composers.open` as an extra `startLine` payload alongside this
 *  anchor. Single-line selection (`start === end`) is unaffected — the
 *  caller passes `undefined` for `startLine` in that case, which is a no-op
 *  change from the prior single-line-only behavior. */
function anchorFromRange(range: SelectedLineRange): { line: number; side: 'LEFT' | 'RIGHT' } {
  const side = (range.endSide ?? range.side) === 'deletions' ? 'LEFT' : 'RIGHT'
  return { line: range.end, side }
}

/** Phase 4b — builds the BASE `options` object passed to <PatchDiff>: theme/
 *  diffStyle/overflow (unchanged since Phase 1) plus the crash-fix-#2
 *  tokenize cap. Extracted so DiffContentPane's own body doesn't inline this
 *  into the JSX (cognitive-complexity ceiling).
 *
 *  BUG FIX: the gutter-"+" click is wired entirely through
 *  `renderGutterUtility`/`GutterAddCommentButton`'s own onClick (see that
 *  component's doc comment in reviewAnnotations.tsx for the full root-cause
 *  writeup) — `options` does NOT set `onGutterUtilityClick`, since that
 *  conflicts with the `renderGutterUtility` React prop DiffContentPane also
 *  passes (`InteractionManager.resolveEnableGutterUtilityOption` throws
 *  "Cannot use both 'onGutterUtilityClick' and 'renderGutterUtility'" the
 *  instant BOTH are non-null).
 *
 *  REGRESSION FIX (invisible gutter "+", this pass): the prior comment above
 *  ALSO dropped `enableGutterUtility: true` from `options` in the same edit,
 *  on the (incorrect) assumption it was part of the same conflict.
 *  `enableGutterUtility` is actually an independent flag —
 *  `InteractionManager`'s constructor only calls `ensureGutterUtilityNode()`
 *  (the code that creates the `[data-gutter-utility-slot]` element Pierre
 *  positions at the hovered line's gutter) `if (enableGutterUtility)` — a
 *  plain truthiness check with NO reference to `onGutterUtilityClick` or
 *  `renderGutterUtility` (confirmed against the installed 1.2.12's
 *  managers/InteractionManager.js). Without `enableGutterUtility: true`, the
 *  slot is never created at all regardless of `renderGutterUtility` being
 *  set — so the "+" render prop below was correctly wired but had nowhere to
 *  mount, in BOTH working-tree and PR-diff mode, since the crash-fix
 *  landed. `resolveEnableGutterUtilityOption`'s throw guard only fires when
 *  `onGutterUtilityClick` is ALSO non-null (verified: `if
 *  (onGutterUtilityClick != null && renderGutterUtility != null) throw`), so
 *  restoring `enableGutterUtility: true` alongside `renderGutterUtility`
 *  (with `onGutterUtilityClick` still omitted) cannot reopen the crash.
 *
 *  PERF FIX (LAG-LAYER #5): deliberately does NOT take `onLineSelected` as a
 *  parameter (it used to) — react-hooks' ref-safety lint rule flags passing
 *  a ref-closing callback into ANY function call during render, even one
 *  that never invokes it synchronously. The caller (DiffContentPaneImpl)
 *  instead spreads this function's return value into its OWN inline object
 *  literal inside `useMemo` and sets `onLineSelected` there directly — see
 *  its own comment. This function's return value still only depends on
 *  primitives (diffStyle/wrapLines/hasComposers), which is what lets the
 *  caller's memo actually recognize two calls as equal instead of always
 *  observing a new object and forcing a full diff DOM re-apply.
 *
 *  Pierre-adoption Batch 1a (docs/learnings/pierre-libraries.md,
 *  scratchpad/pierre-roadmap.json "quick-win" items) — four static option
 *  fields confirmed against node_modules/@pierre/diffs/dist/types.d.ts's
 *  `BaseDiffOptions`/`BaseCodeOptions` before adding (versions drift; every
 *  field name/value below was checked against the installed 1.2.12, not
 *  assumed from the README):
 *   - `lineDiffType: 'word-alt'` — CDP-verified that Pierre already renders
 *     per-token intra-line highlighting on a MODIFIED line (an added/deleted
 *     line has no counterpart to diff against, so it's solid — that's
 *     correct, not a bug) even without this field set, since 'word-alt' is
 *     BaseDiffOptions' own default. Set explicitly anyway so the choice is
 *     documented in code, not just inherited silently, and so a future
 *     Pierre version changing its default doesn't silently change Orpheus's
 *     rendering.
 *   - `tokenizeMaxLength: DIFF_TOKENIZE_MAX_LENGTH` — see that constant's own
 *     comment: a whole-diff byte cap distinct from `tokenizeMaxLineLength`
 *     above, belt-and-suspenders alongside (not a replacement for) the
 *     OversizedDiffPlaceholder gate the caller applies before this component
 *     ever mounts <PatchDiff>.
 *   - `diffIndicators: 'classic'` — GitHub-style +/-  glyphs in the gutter
 *     instead of the default 'bars' (a plain colored vertical bar with no
 *     glyph). Chosen over 'bars' because Orpheus's Git tab is explicitly a
 *     git-review surface where users already have a GitHub-diff mental
 *     model — the +/- glyph reads faster than a color-only bar at a glance,
 *     and CDP-verified that 'classic' renders cleanly against the
 *     pierre-dark gutter background.
 *   - `hunkSeparators: 'line-info'` — KEPT (already the default) rather than
 *     changed, since 'line-info' is what renders the "N unmodified lines"
 *     collapsed-context band the task requires stay visible. Set explicitly
 *     for the same self-documentation reason as lineDiffType above.
 */
function buildDiffOptions(
  diffStyle: DiffStyle,
  wrapLines: boolean,
  hasComposers: boolean
): FileDiffOptions<ReviewAnnotationMeta> {
  const base: FileDiffOptions<ReviewAnnotationMeta> = {
    theme: VIEWER_THEME,
    themeType: 'dark',
    diffStyle,
    overflow: wrapLines ? 'wrap' : 'scroll',
    // Crash fix #2 (belt-and-suspenders) — the oversized-file gate above
    // already keeps genuinely huge patches out of <PatchDiff> entirely, but a
    // single extremely long line (a minified bundle's one-liner, still under
    // the oversized byte/line thresholds) would otherwise force a full
    // synchronous Shiki tokenize pass on that line. Cap it so Pierre falls
    // back to plaintext for any one line beyond this length instead.
    tokenizeMaxLineLength: DIFF_TOKENIZE_MAX_LINE_LENGTH,
    // Whole-diff cap — see DIFF_TOKENIZE_MAX_LENGTH's own comment.
    tokenizeMaxLength: DIFF_TOKENIZE_MAX_LENGTH,
    // Word/token-level intra-line diff highlighting — see this function's
    // own doc comment for why this is set explicitly despite matching the
    // library default.
    lineDiffType: 'word-alt',
    // GitHub-style +/- gutter glyphs — see this function's own doc comment.
    diffIndicators: 'classic',
    // Renders the "N unmodified lines" collapsed-context band — already the
    // library default; set explicitly for self-documentation.
    hunkSeparators: 'line-info'
  }
  if (!hasComposers) return base
  return {
    ...base,
    // Select-to-comment: scoped to reporting the FINAL committed selection
    // (`onLineSelected`, fired once per gesture) rather than every
    // in-progress tick (`onLineSelectionChange`) — opening a composer per
    // intermediate frame while the user is still dragging would be noisy
    // and would fight the "one composer per exact anchor" de-dupe in
    // useReviewComposers.open. A `null` range means the selection was
    // cleared (e.g. clicking elsewhere) — nothing to open. `onLineSelected`
    // itself is set by the caller (see this function's own doc comment on
    // why it can't be a parameter here).
    enableLineSelection: true,
    // REGRESSION FIX (invisible gutter "+") — see this function's own doc
    // comment above: required for @pierre/diffs' InteractionManager to ever
    // create the `[data-gutter-utility-slot]` element `renderGutterUtility`
    // renders into. Safe alongside `renderGutterUtility` since
    // `onGutterUtilityClick` (the option that actually conflicts with it) is
    // never set here.
    enableGutterUtility: true
  }
}

// --- Pierre adoption batch 4 — merge-conflict DETECTION + DISPLAY (READ-ONLY) ---

/** Counts conflict regions in a conflicted file's raw contents by scanning
 *  for `<<<<<<<` conflict-start markers, one per region — the SAME regex
 *  (`MERGE_CONFLICT_START_MARKER_REGEX`, `^<{7,}`) @pierre/diffs' own
 *  internal parser (parseMergeConflictDiffFromFile) uses to find conflict
 *  boundaries. Reimplemented here (rather than calling that parser directly)
 *  because it — and the `useUnresolvedFileInstance` hook that surfaces its
 *  `actions`/`markerRows` output — are NOT part of the package's public API:
 *  verified against the installed 1.2.12's dist/{index,react/index}.d.ts,
 *  both only live under `dist/utils/`/`dist/react/utils/`, which the
 *  package's `exports` map doesn't expose for deep-import. This is a plain
 *  per-line regex test (no parsing/rendering), matching GitTab's module
 *  header's "Display" note. */
function countConflictRegions(contents: string): number {
  let count = 0
  for (const line of contents.split('\n')) {
    if (MERGE_CONFLICT_START_MARKER_REGEX.test(line)) count++
  }
  return count
}

/** Pierre-adoption batch 4 — the conflict-viewer branch of the diff pane,
 *  rendered instead of the normal <PatchDiff> whenever the selected file's
 *  path is in `conflictedPaths` (see GitTab's module header's "Display"
 *  note). READ-ONLY: fetches the file's raw on-disk contents (conflict
 *  markers included) via the existing `files:readFile` IPC — the same one
 *  FilesTab's text viewer and this file's own BinaryImageBody use — and
 *  feeds them straight into @pierre/diffs/react's `<UnresolvedFile>`, which
 *  parses the `<<<<<<<`/`|||||||`/`=======`/`>>>>>>>` markers (diff3 base
 *  region included, if present) and renders the current/incoming regions
 *  itself; no client-side diff/patch construction needed.
 *
 *  `mergeConflictActionsType: 'none'` is the entire "no resolve buttons"
 *  requirement — Pierre renders NO accept/reject action slots at all in that
 *  mode (confirmed against components/UnresolvedFile.d.ts's
 *  `MergeConflictActionsTypeOption`), so there's no disabled-button chrome to
 *  build. `onMergeConflictAction`/`onMergeConflictResolve` are left
 *  unset — nothing here ever calls `resolveConflict` or `files:writeFile`;
 *  that write-back path is explicitly deferred to a later batch.
 *
 *  The "N conflicts" badge uses `countConflictRegions` on the SAME fetched
 *  contents (not a second read) — see that function's doc comment for why
 *  it's a local regex scan rather than a call into Pierre's own (non-public)
 *  parser. */
function ConflictDiffPane({
  workspaceId,
  path,
  wrapLines
}: {
  workspaceId: string
  path: string
  wrapLines: boolean
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<{ path: string; file: GitFileContents } | null>(null)
  useEffect(() => {
    let cancelled = false
    window.api.files
      .readFile(workspaceId, path)
      .then((file) => {
        if (!cancelled) setLoaded({ path, file })
      })
      .catch((e) => {
        console.error('[GitTab] readFile (conflict view) failed:', e)
        if (!cancelled) setLoaded({ path, file: null as unknown as GitFileContents })
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, path])

  const current = loaded && loaded.path === path ? loaded.file : null
  if (current === null) return <DiffMessage text="Loading…" />
  if (current.binary) return <DiffMessage text="Binary file — no conflict preview" />

  const conflictCount = countConflictRegions(current.contents)
  const fileName = path.split('/').pop() ?? path

  return (
    <div className="flex-1 min-h-0 flex flex-col" style={{ backgroundColor: PIERRE_VIEWER_BG }}>
      <div className="flex-shrink-0 flex items-center gap-2 h-7 px-3 border-b border-border-default">
        <GitMerge size={13} className="text-amber-400" />
        <span className="text-[11px] text-text-muted select-none">
          {conflictCount} conflict{conflictCount === 1 ? '' : 's'} remaining — resolution coming
          soon
        </span>
      </div>
      <Virtualizer className="flex-1 min-h-0 overflow-auto">
        <UnresolvedFile
          key={path}
          file={{ name: fileName, contents: current.contents }}
          options={{
            theme: VIEWER_THEME,
            themeType: 'dark',
            overflow: wrapLines ? 'wrap' : 'scroll',
            tokenizeMaxLineLength: DIFF_TOKENIZE_MAX_LINE_LENGTH,
            tokenizeMaxLength: DIFF_TOKENIZE_MAX_LENGTH,
            lineDiffType: 'word-alt',
            diffIndicators: 'classic',
            // READ-ONLY — disables Pierre's own accept/reject action slots
            // entirely (see this component's doc comment).
            mergeConflictActionsType: 'none'
          }}
        />
      </Virtualizer>
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
 *  gets a plain "no preview" placeholder.
 *
 *  Phase 4b/5: the gutter "+"/select-to-comment affordance
 *  (renderGutterUtility + the select-to-comment option from
 *  buildDiffOptions) is wired whenever `composers` is non-null — as of
 *  Phase 5 FIX 1 that's BOTH modes (see DiffContentPaneProps' doc comment):
 *  working-tree mode gets a local-only composer, PR-diff mode gets the full
 *  [GitHub | Local] composer. See GutterAddCommentButton's doc comment
 *  (reviewAnnotations.tsx) for the bug fix (Phase 4c) to how the gutter "+"
 *  click itself is wired. */
export interface DiffContentPaneProps {
  workspaceId: string
  file: GitDiffFile | null
  diffStyle: DiffStyle
  wrapLines: boolean
  loading: boolean
  /** Phase 4a — PR review-comment threads for the CURRENTLY selected file
   *  only (already filtered by path), or null when annotations don't apply
   *  (working-tree mode, or no PR-diff comments loaded yet/failed). GitTab
   *  only ever passes a non-null list while `diffMode === 'pr'` — GitHub
   *  comments anchor to the PR diff, not the live working tree (see
   *  docs/learnings/pr-comments.md's Q1 gap note) — this stays PR-diff-only
   *  even after Phase 5's FIX 1 below. */
  reviewThreads: readonly GhReviewCommentThread[] | null
  /** Phase 4b — the "add a comment" affordance (gutter "+" + select-to-
   *  comment). `null` means "don't wire the affordance at all" (no diff
   *  loaded); a non-null value means it's ALWAYS available now (Phase 5 FIX
   *  1: previously PR-diff-mode-only, since a GitHub post has nothing to
   *  anchor to without a PR — but a LOCAL comment (reviews:add) needs no PR
   *  at all, so GitTab now passes this unconditionally in both modes; see
   *  `allowGithubComments` below for how the composer still knows whether
   *  GitHub is actually a valid destination). */
  composers: ReviewComposerWiring | null
  /** Phase 4c — refetches `reviewThreads` (GitTab's own `fetchReviewComments`
   *  helper, bound to `setReviewThreads`). Passed down to ReviewCommentThread
   *  via renderReviewCommentAnnotation so a successful Reply post refreshes
   *  the thread list the same way a new-comment post does. A no-op function
   *  in working-tree mode (nothing ever renders a thread there to reply to,
   *  so this is never actually invoked in that mode — kept required rather
   *  than optional so every call site is explicit about wiring it). */
  onRefetchThreads: () => void
  /** Phase 4d — LOCAL review comments for the CURRENTLY selected file only
   *  (GitTab passes the full per-workspace list; `annotationsForFile` filters
   *  by path the same way it already does for threads/composers). A plain
   *  array (never null) in EITHER mode as of Phase 5 FIX 1 — local comments
   *  have no PR requirement, so there's no "not applicable" state, only
   *  "empty so far", in both working-tree and PR-diff mode. */
  localComments: readonly LocalReviewComment[]
  /** Phase 4d — resolve/delete actions for a LOCAL comment's card, plus the
   *  source toggle wiring for the NEW-comment composer (GitHub vs Local —
   *  see CommentComposer.tsx's own SourceToggle). Phase 5 FIX 1: passed
   *  unconditionally now (both modes), same reasoning as `composers` above —
   *  `allowGithubComments` (not this being non-null) is what actually gates
   *  whether the SourceToggle itself renders. */
  localWiring: LocalCommentWiring | null
  /** Phase 5 FIX 1 — `diffMode === 'pr'`: whether GitHub is a valid
   *  destination for a NEW comment right now. Threaded down (rather than
   *  inferring it from `reviewThreads !== null`, which can legitimately be
   *  null in PR-diff mode too, e.g. a failed fetch) so
   *  renderReviewCommentAnnotation can omit the pending composer's [GitHub |
   *  Local] SourceToggle entirely in working-tree mode — there's no PR to
   *  post a GitHub comment to there, so the composer is local-only. */
  allowGithubComments: boolean
  /** Pierre adoption batch 4 (safe/read-only slice) — repo-relative paths
   *  currently reported as merge-conflicted (`git status`'s unmerged XY
   *  codes — see src/main/git.ts's getConflictedPaths). When the selected
   *  `file.path` is a member, DiffContentPane renders ConflictDiffPane
   *  (@pierre/diffs' <UnresolvedFile>, read-only) instead of the normal
   *  <PatchDiff> — see GitTab's module header's "Display" note. Empty in
   *  the overwhelmingly common case (no live conflict), so this branch is
   *  dormant by construction until a real conflict exists. */
  conflictedPaths: ReadonlySet<string>
  /** PERF FIX (token-hover lift) — `useTokenHoverPopover` lives in the
   *  PARENT (GitTabBody), not in this memoized pane, so a hovered token's
   *  setState re-renders only the tiny sibling <TokenHoverPopover>, not this
   *  pane's whole <PatchDiff> subtree. Both are the hook's own stable
   *  (empty-deps useCallback) identities — see useTokenHoverPopover.ts's own
   *  doc comment — so threading them down here doesn't destabilize the
   *  `options` useMemo below or defeat this component's React.memo. */
  onTokenEnter: UseTokenHoverPopoverResult['onTokenEnter']
  onTokenLeave: UseTokenHoverPopoverResult['onTokenLeave']
}

/** Phase 4b/4c — the subset of `useReviewComposers`'s result DiffContentPane
 *  needs, plus the submit callback (Phase 4c: now a real async post, see
 *  GitTab's `submitReviewComment`). Kept as its own small interface (rather
 *  than threading the whole hook result down) so this pane's prop surface
 *  only names what it actually uses. */
export interface ReviewComposerWiring {
  composers: readonly PendingComposer[]
  open: (path: string, side: 'LEFT' | 'RIGHT', line: number, startLine?: number) => void
  close: (id: string) => void
  onSubmit: (draft: CommentDraft) => Promise<GhSubmitResult>
}

/** PERF FIX (LAG-LAYER #5): every value this ref carries is read ONLY from
 *  inside the stable `onLineSelected` callback below (never during render),
 *  so `DiffContentPaneImpl` can build that callback ONCE (empty deps) instead
 *  of on every render — which in turn lets `buildDiffOptions`'s return value
 *  be memoized on plain primitives instead of always allocating a fresh
 *  `options` object (defeating Pierre's `areOptionsEqual` and forcing a full
 *  diff DOM re-apply). */
interface LatestSelectHandlerInputs {
  path: string
  composers: ReviewComposerWiring | null
}

function DiffContentPaneImpl({
  workspaceId,
  file,
  diffStyle,
  wrapLines,
  loading,
  reviewThreads,
  composers,
  onRefetchThreads,
  localComments,
  localWiring,
  allowGithubComments,
  conflictedPaths,
  onTokenEnter,
  onTokenLeave
}: DiffContentPaneProps): React.JSX.Element {
  // Crash fix #1 — per-file "show anyway" override for an oversized diff.
  // Lives here (not keyed to a single file, since DiffContentPane itself
  // isn't remounted per selection — only the inner <PatchDiff key={path}> is)
  // so switching away and back to an already-force-shown file doesn't ask
  // again within the same Git-tab session.
  const [shownAnyway, setShownAnyway] = useState<ReadonlySet<string>>(() => new Set())

  // PERF FIX (LAG-LAYER #5): the hooks below must run UNCONDITIONALLY on
  // every render (rules-of-hooks) — so they're hoisted above every early
  // return (loading/no-selection/binary/oversized), even though their
  // OUTPUT is only actually used by the plain-diff JSX at the bottom. This
  // is what lets `lineAnnotations`/`options` stay referentially stable
  // across an unrelated re-render (e.g. the tree-drag commit, prDetail
  // ticks) instead of forcing @pierre/diffs to re-apply the whole diff DOM.
  const path = file?.path ?? null
  const latestRef = useRef<LatestSelectHandlerInputs>({ path: path ?? '', composers })
  useEffect(() => {
    latestRef.current = { path: path ?? '', composers }
  })

  // Stable identity (empty deps) for the whole component lifetime — reads
  // the CURRENT path/composers off latestRef rather than closing over the
  // render's own values, so it never needs to be recreated.
  const onLineSelected = useCallback((range: SelectedLineRange | null) => {
    if (range === null) return
    const { composers: currentComposers, path: currentPath } = latestRef.current
    if (currentComposers === null) return
    const { line, side } = anchorFromRange(range)
    // A true multi-line drag (start !== end) threads its START line through
    // as an extra `startLine` payload on the SAME anchor — see
    // anchorFromRange's own doc comment + useReviewComposers.open's updated
    // signature. Single-line selection (the common case) passes undefined,
    // which is a no-op change from the prior behavior.
    const startLine = range.start !== range.end ? range.start : undefined
    currentComposers.open(currentPath, side, line, startLine)
  }, [])

  // Pierre adoption Batch 3 — token hover popover. PERF FIX (token-hover
  // lift): the controller hook itself lives one level UP in GitTabBody (not
  // here) so a hovered token's setState no longer re-renders this whole
  // pane's <PatchDiff> subtree — only `onTokenEnter`/`onTokenLeave` (both
  // stable, empty-deps callbacks per useTokenHoverPopover.ts's own doc
  // comment) flow down as props, wired unconditionally (not gated on
  // hasComposers, unlike select-to-comment below): it's a passive, read-only
  // affordance orthogonal to composers/annotations.

  // Phase 4a/4b/4d/5: only computed while EITHER reviewThreads is non-null
  // (PR-diff mode with a loaded/attempted GitHub comment fetch) OR
  // localWiring is non-null (now true in BOTH modes as of Phase 5 FIX 1) —
  // annotationsForFile itself returns [] for a file with no threads/
  // composers/local comments, which PatchDiff renders exactly like an
  // omitted lineAnnotations prop (a plain diff, no annotations). Memoized so
  // an unrelated re-render (tree-drag commit, prDetail poll tick) doesn't
  // reallocate a fresh (but content-equal) array every time — a fresh array
  // identity alone is enough to make @pierre/diffs treat annotations as
  // "changed" and re-apply the diff DOM.
  const showAnnotations = reviewThreads !== null || localWiring !== null
  const composerList = composers?.composers ?? EMPTY_COMPOSERS
  const lineAnnotations = useMemo(
    () =>
      showAnnotations && path !== null
        ? annotationsForFile(reviewThreads ?? [], composerList, localComments, path)
        : undefined,
    [showAnnotations, reviewThreads, composerList, localComments, path]
  )

  // Memoized on primitives + the composers-WIRING identity only — see
  // buildDiffOptions' own doc comment for why this is the fix for the
  // "fresh onLineSelected every render" forceRender bug. `onLineSelected` is
  // spread in via this OWN inline object literal (not passed as an argument
  // into buildDiffOptions) — react-hooks' ref-safety lint rule flags a
  // ref-closing callback passed into any function call during render, but
  // accepts it being placed directly into an object literal the same way a
  // DOM `ref` prop is accepted. `onTokenEnter`/`onTokenLeave` are spread the
  // same way, unconditionally (not gated on hasComposers) — both are stable
  // (empty deps) so adding them here doesn't add a new dependency to this
  // memo's array.
  const hasComposers = composers !== null
  const options = useMemo(() => {
    const base = buildDiffOptions(diffStyle, wrapLines, hasComposers)
    const withTokenHover = {
      ...base,
      onTokenEnter,
      onTokenLeave
    }
    return hasComposers ? { ...withTokenHover, onLineSelected } : withTokenHover
  }, [diffStyle, wrapLines, hasComposers, onLineSelected, onTokenEnter, onTokenLeave])

  if (loading) return <DiffMessage text="Loading…" />
  if (file === null) return <DiffMessage text="Select a changed file to view its diff" />
  // Pierre adoption batch 4 (safe/read-only slice) — a conflicted file's
  // `git diff HEAD` patch chunk isn't a meaningful 2-way diff (the working
  // copy holds unresolved 3-way conflict markers, not a clean edit), so this
  // check runs BEFORE the binary/oversized branches below and takes over the
  // whole pane with the read-only Pierre conflict viewer instead. See
  // GitTab's module header's "Display" note + ConflictDiffPane's own doc
  // comment.
  if (conflictedPaths.has(file.path)) {
    return <ConflictDiffPane workspaceId={workspaceId} path={file.path} wrapLines={wrapLines} />
  }
  if (file.binary) {
    if (isImagePath(file.path)) {
      return <BinaryImageBody workspaceId={workspaceId} path={file.path} />
    }
    return <DiffMessage text="Binary file — no preview" />
  }
  // CRASH FIX (React #185 "Show anyway" crash — see hasRenderablePatch's own
  // doc comment): a patch-less oversized file (GitHub's files-API fallback
  // declined to diff it — gitDiff.ts's apiFileWithoutPatch) has nothing for
  // "Show anyway" to reveal, and feeding its empty `patch` into <PatchDiff>
  // is exactly what threw during render and crashed the workspace view. This
  // check runs BEFORE the `shownAnyway` gate below so it takes precedence
  // even if the path was already force-shown in a PRIOR selection (can't
  // happen today since `oversized` without a patch is a stable server-derived
  // property, but keeps this branch authoritative regardless of that state).
  if (file.oversized && !hasRenderablePatch(file.patch)) {
    return <DiffMessage text="Diff not available for this file — view it on GitHub" />
  }
  if (file.oversized && !shownAnyway.has(file.path)) {
    return (
      <OversizedDiffPlaceholder
        lineCount={file.additions + file.deletions}
        onShowAnyway={() =>
          setShownAnyway((prev) => {
            const next = new Set(prev)
            next.add(file.path)
            return next
          })
        }
      />
    )
  }
  // Defense in depth (same crash fix): a non-oversized file should never
  // reach here with a non-renderable patch (fileFromChunk always derives
  // `patch` from a real matched chunk) — but guarding the <PatchDiff> mount
  // itself means a future diff-source change can't reopen the exact same
  // render-phase throw by constructing a `GitDiffFile` with a blank/degenerate
  // patch outside the oversized path above.
  if (!hasRenderablePatch(file.patch)) {
    return <DiffMessage text="Diff not available for this file" />
  }
  return (
    // PERF FIX (token-hover lift): this pane no longer renders its own
    // <TokenHoverPopover> — the parent (GitTabBody) owns the hook + popover
    // now so a hovered token's setState doesn't re-render this subtree (see
    // DiffContentPaneProps' onTokenEnter/onTokenLeave doc comment). This
    // used to be a <> Fragment wrapping <Virtualizer> + <TokenHoverPopover>;
    // with the popover gone, <Virtualizer> is the sole root element and the
    // Fragment is gone too.
    //
    // Line-level virtualization (Pierre adoption batch 2a) — <Virtualizer> is
    // the scroll root itself (it renders the fixed-height `overflow`
    // container + an inner content div and calls `.setup(root)` on mount, see
    // node_modules/@pierre/diffs/dist/components/Virtualizer.js). Its mere
    // PRESENCE as a React context ancestor is the entire switch: <PatchDiff>
    // (→ useFileDiffInstance, dist/react/utils/useFileDiffInstance.js) calls
    // useVirtualizer() internally and, when non-null, instantiates
    // VirtualizedFileDiff instead of FileDiff — same <PatchDiff> JSX, no prop
    // needed, no `metrics` required (VirtualizedFileDiff's constructor
    // defaults it — see computeVirtualFileMetrics.js). This replaces the
    // previous plain `overflow-auto` div, which is exactly the scroll root
    // <Virtualizer> now owns.
    //
    // Annotation/gutter compatibility (verified against the installed
    // 1.2.12 dist, not assumed): VirtualizedFileDiff EXTENDS FileDiff and
    // only overrides layout/visibility bookkeeping — `renderAnnotation`/
    // `renderGutterUtility`/`lineAnnotations` are rendered by the same
    // shared `renderDiffChildren` template (light-DOM children projected
    // into Pierre's shadow-DOM slots) regardless of virtualization, and
    // `setLineAnnotations`/`syncLineAnnotations` keep annotation state keyed
    // to line numbers independent of which lines are currently windowed —
    // scrolling a commented line back into view re-materializes its row
    // (and slot) exactly like any other line. Token hover (Pierre adoption
    // batch 3) needs no virtualization-aware code of its own: Pierre's
    // InteractionManager operates on the currently-mounted DOM regardless
    // of windowing, same as the gutter utility above.
    <Virtualizer
      className="flex-1 min-h-0 overflow-auto"
      style={{ backgroundColor: PIERRE_VIEWER_BG }}
    >
      <PatchDiff
        key={file.path}
        patch={file.patch}
        options={options}
        lineAnnotations={lineAnnotations}
        renderAnnotation={(annotation) =>
          renderReviewCommentAnnotation(
            annotation,
            workspaceId,
            onRefetchThreads,
            composers?.close,
            composers?.onSubmit,
            localWiring ?? undefined,
            allowGithubComments
          )
        }
        renderGutterUtility={
          composers !== null
            ? (getHoveredLine) => (
                <GutterAddCommentButton
                  getHoveredLine={getHoveredLine}
                  onAdd={(lineNumber, side) =>
                    composers.open(file.path, side === 'deletions' ? 'LEFT' : 'RIGHT', lineNumber)
                  }
                />
              )
            : undefined
        }
      />
    </Virtualizer>
  )
}

/** PERF FIX (LAG-LAYER #5) — a stable empty-array fallback for `composers?.
 *  composers` so `lineAnnotations`'s useMemo deps don't see a fresh `[]`
 *  identity every render when `composers` is null. */
const EMPTY_COMPOSERS: readonly PendingComposer[] = []

/** PERF FIX (LAG-LAYER #4/#5): memoized so an unrelated re-render one level
 *  up (prDetail poll tick, tree-drag width COMMIT on mouseup, branch churn)
 *  doesn't force @pierre/diffs to re-apply the entire (non-virtualized) diff
 *  DOM — React.memo's shallow prop comparison short-circuits the re-render
 *  entirely when every prop is referentially unchanged, which is now the
 *  common case since the props this pane receives are themselves stabilized
 *  in GitTab/GitTabBody. */
const MemoizedDiffContentPane = memo(DiffContentPaneImpl)

interface DiffPaneErrorBoundaryState {
  error: string | null
}

/** CRASH FIX (React #185 "Show anyway" crash) — defense in depth alongside
 *  `hasRenderablePatch`'s render-time guard above. That guard fixes the
 *  KNOWN cause (an empty/degenerate `file.patch` reaching <PatchDiff>), but
 *  @pierre/diffs is a third-party rendering engine this codebase doesn't
 *  control end to end — a different malformed-patch shape (or a future
 *  Pierre version) could throw from the same `usePatch`/`getSingularPatch`
 *  path in a way `hasRenderablePatch`'s heuristic doesn't anticipate. Before
 *  this fix there was only ONE error boundary in the whole app
 *  (`AppErrorBoundary`, main.tsx), so any throw here tore down the ENTIRE
 *  workspace view (confirmed live via CDP: the diagnostics' `terminal.hide`
 *  immediately following the React error). Scoping a boundary to just this
 *  pane means a future Pierre throw degrades to an inline message in the
 *  diff pane only — the file tree, terminal, and rest of the workspace stay
 *  alive. Keyed on `file?.path` by the caller (see `DiffContentPane` below)
 *  so switching to a different file after a crash doesn't stay stuck on the
 *  error card — a fresh path remounts a fresh (non-errored) boundary. */
class DiffPaneErrorBoundary extends Component<
  { children: React.ReactNode },
  DiffPaneErrorBoundaryState
> {
  state: DiffPaneErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): DiffPaneErrorBoundaryState {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown): void {
    console.error('[DiffContentPane] render error (caught locally):', error)
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return <DiffMessage text="Couldn't render this diff — try selecting the file again" />
    }
    return this.props.children
  }
}

/** Exported wrapper — same props/identity contract as before (still a plain
 *  component GitTab/GitTabBody renders unchanged), now with the local error
 *  boundary in between. `key={file?.path ?? null}` on the boundary resets
 *  its caught-error state whenever the selected file changes, so a crash on
 *  one file doesn't leave every subsequent selection stuck on the fallback
 *  card. */
export function DiffContentPane(props: DiffContentPaneProps): React.JSX.Element {
  return (
    <DiffPaneErrorBoundary key={props.file?.path ?? null}>
      <MemoizedDiffContentPane {...props} />
    </DiffPaneErrorBoundary>
  )
}
