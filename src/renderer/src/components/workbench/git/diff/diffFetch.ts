// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/diff/diffFetch.ts
//
// GitTab's PURE diff-fetch/signature helpers — extracted verbatim from
// GitTab.tsx (Wave 3 Phase A structural extraction; see the "GitTab god
// component" audit finding). Every function here is prop-driven: it takes a
// `workspaceId`/callback and returns a cancel function or a plain value, with
// NO closures over GitTab's own refs/state. That's the extraction boundary —
// GitTab.tsx still owns every effect that CALLS these (the ref bookkeeping —
// lastAppliedSigRef, lastFetchedModeForWorkspaceRef, diffModeRef, prRef, etc.
// — is Phase B territory, deliberately not touched here).
//
// diffSignature/isUnchangedDiffResult — the idempotent-refetch guard: a
// settled `git:diff`/`git:prDiff` result identical to what's already applied
// is a no-op (no re-render, no <PatchDiff> remount) — see diffSignature's own
// comment for the perf history (LAG-LAYER #7's cyrb53-hash-based signature,
// then the main-side `{unchanged: true}` sentinel this file's
// isUnchangedDiffResult narrows).
//
// fetchDiff/fetchPrDiff/fetchForMode — the working-tree vs PR-diff data
// sources, sharing one fetch/cancel/onSettled contract so GitTab's effects
// can stay mode-agnostic.
//
// fetchReviewComments/fetchLocalReviews/fetchConflicts — one-shot refetch
// helpers for GitHub review threads, local (Orpheus-owned) review comments,
// and the read-only merge-conflict path list, respectively.
//
// EMPTY_CONFLICTS/sameSetContents/setConflictedPathsIfChanged — identity-
// reuse plumbing for `conflictedPaths` so a same-contents refetch doesn't
// force a fresh Set reference through memo'd GitTabBody/DiffContentPane (see
// setConflictedPathsIfChanged's own doc comment).
// ---------------------------------------------------------------------------

import type React from 'react'
import type {
  GhReviewCommentThread,
  GitDiffFile,
  GitDiffResult,
  GitDiffUnchangedResult,
  LocalReviewComment
} from '@shared/types'
import type { DiffMode } from '../../GitTab'

/** A settled `git:diff` result, as GitTab needs it: the discriminator plus
 *  the files. Named separately from GitDiffResult so a network/IPC failure
 *  (caught below) can still produce a value of this shape — `repo: true`
 *  with an empty `files[]` is the deliberate "assume it's a repo, just
 *  couldn't read it right now" fallback, matching the old pre-Phase-2
 *  behavior of silently resolving to an empty diff on any failure. */
export interface DiffSettleResult {
  repo: boolean
  files: GitDiffFile[]
}

/** Fix 1 — the auto-select rule applied every time a fresh `files[]` result
 *  settles (initial load, live-refresh refetch): keep the current selection
 *  if that path is STILL present in the new result (a refresh must not yank
 *  the user off the file they're looking at); otherwise fall back to the
 *  first changed file so the tab always shows a diff by default instead of
 *  the empty "Select a file" state. Returns null only when `files` itself is
 *  empty (a clean tree — nothing to select). Pure so it's trivially testable
 *  and keeps the effects below declarative. */
export function nextSelection(
  files: readonly GitDiffFile[],
  current: string | null
): string | null {
  if (current !== null && files.some((f) => f.path === current)) return current
  return files[0]?.path ?? null
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
// (any changed patch text changes its own entry) and still applies.
//
// PERF FIX (LAG-LAYER #7): this used to concatenate every file's FULL patch
// TEXT into one giant string per settle (`path\x00status\x00patch`, joined by
// `\x01`) purely to build a comparison key — on a large diff that's a
// multi-MB string allocation on every debounced live-refresh, just to detect
// a no-op. `f.sig` (src/main/gitDiff.ts's fileFromChunk) is a cyrb53 content
// hash already computed ONCE per file in main over the exact same
// path+status+patch inputs, so combining those short per-file hashes here is
// O(files.length) string-building instead of O(total-diff-bytes) — same
// correctness (a same-length content edit still changes its file's hash, so
// still registers as a change; see gitDiff.ts's own doc comment for why this
// is a 53-bit hash, not 32-bit or length-only). The `\x00`/`\x01` separators
// are no longer needed (no raw patch text flows through this function
// anymore) but kept as the join delimiter for consistency/no-collision with
// any hash value itself.
export function diffSignature(result: DiffSettleResult): string {
  if (!result.repo) return 'no-repo'
  return result.files.map((f) => f.sig).join('\x01')
}

/** The union `window.api.git.diff` actually resolves with (see
 *  GitDiffUnchangedResult's own doc comment) — named locally so
 *  `isUnchangedDiffResult`'s signature reads plainly. */
type GitDiffOrUnchanged = GitDiffResult | GitDiffUnchangedResult

/** True iff `git:diff` returned the additive main-side no-op sentinel (see
 *  GitDiffUnchangedResult's own doc comment) instead of a real
 *  `GitDiffResult`. Narrows the union `fetchDiff` receives from
 *  `window.api.git.diff` before it can safely read `.files`. */
function isUnchangedDiffResult(result: GitDiffOrUnchanged): result is GitDiffUnchangedResult {
  return 'unchanged' in result && result.unchanged === true
}

/** Fetch the working-tree diff for `workspaceId`. Extracted so the debounced
 *  refetch effect below and the initial-load effect share one code path,
 *  keeping GitTab's own body under the cognitive-complexity ceiling.
 *
 *  PERF FIX (main-side diff no-op detection) — `git:diff` may resolve with
 *  the `{ unchanged: true }` sentinel (see GitDiffUnchangedResult's own doc
 *  comment) when main's own last-signature cache for this workspaceId
 *  matched: that means NOTHING changed since the last settle already applied
 *  by `applyDiff`'s own diffSignature idempotency, so `onSettled` is simply
 *  never called — same observable effect as calling it with an
 *  identical-signature result (a no-op), just without the wasted
 *  files[]-shaped allocation/compare. The renderer's own diffSignature guard
 *  in `applyDiff` stays as the backstop for every OTHER path into this
 *  callback (fetchPrDiff, which is untouched by this fix). */
export function fetchDiff(
  workspaceId: string,
  onSettled: (result: DiffSettleResult) => void
): () => void {
  let cancelled = false
  window.api.git
    .diff(workspaceId)
    .then((result) => {
      if (cancelled || isUnchangedDiffResult(result)) return
      onSettled({ repo: result.repo, files: result.files })
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
export function fetchPrDiff(
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

/** Fetch review-comment threads (Phase 4a) for `workspaceId`'s current PR,
 *  reporting the settled value (or null on failure) via `onSettled`. Fire-
 *  and-forget by design (unlike fetchDiff/fetchPrDiff, callers here don't
 *  need a cancel token — this is only called from the onPrChanged event
 *  callback's "PR changed while already in PR-diff mode" branch, a single
 *  one-shot refetch, not a mount/dependency-driven effect that could race a
 *  cleanup). */
export function fetchReviewComments(
  workspaceId: string,
  onSettled: (threads: GhReviewCommentThread[] | null) => void
): void {
  window.api.github
    .prReviewComments(workspaceId)
    .then(onSettled)
    .catch((e) => {
      console.error('[GitTab] github:prReviewComments failed:', e)
      onSettled(null)
    })
}

/** Phase 4d — fetch the LOCAL review-comment store's full list for
 *  `workspaceId`, reporting the settled value via `onSettled` (falls back to
 *  `[]` on failure — an empty list renders identically to "no local comments
 *  yet", never blocking the diff pane). Fire-and-forget, same shape as
 *  fetchReviewComments above (this is also only ever called as a one-shot
 *  refetch after a mutation or on workspace change, never inside a bare
 *  mount effect that needs its own cancel token). */
export function fetchLocalReviews(
  workspaceId: string,
  onSettled: (comments: LocalReviewComment[]) => void
): void {
  window.api.reviews
    .list(workspaceId)
    .then(onSettled)
    .catch((e) => {
      console.error('[GitTab] reviews:list failed:', e)
      onSettled([])
    })
}

/** Diff-mode dispatcher — the [Working tree | PR diff] toggle's data-source
 *  switch (Phase 4-pre). Both branches share the exact same
 *  fetch/cancel/onSettled contract, so every call site (initial load, mode
 *  switch, live-refresh) can stay mode-agnostic by just calling this. */
export function fetchForMode(
  mode: DiffMode,
  workspaceId: string,
  onSettled: (result: DiffSettleResult) => void
): () => void {
  return mode === 'pr' ? fetchPrDiff(workspaceId, onSettled) : fetchDiff(workspaceId, onSettled)
}

/** Pierre adoption batch 4 (safe/read-only slice) — fetch the READ-ONLY
 *  `git:conflicts` list for `workspaceId`, reporting the settled value as a
 *  `ReadonlySet<string>` via `onSettled` (falls back to an empty set on
 *  failure — no conflicts detected renders identically to "no live conflict",
 *  never blocking the diff pane). Working-tree-only, same rationale as
 *  fetchDiff's own PR-diff-mode exclusion: a PR diff (`base...head` against
 *  committed history) can't itself be "conflicted" the way a live working
 *  tree can — see GitTab's PR-diff-mode fetch effect, which never calls
 *  this. */
// PERF FIX (conflicted-paths identity) — a shared empty-set instance for the
// dominant (no live conflict) case. Returning this SAME reference every time
// `paths.length === 0` settles means the fetch effect below can skip its
// setState entirely on the common "still no conflicts" tick — see
// setConflictedPathsIfChanged's own doc comment for the non-empty case.
export const EMPTY_CONFLICTS: ReadonlySet<string> = new Set()

/** True iff `a` and `b` contain exactly the same members (order-independent).
 *  `conflictedPaths` is only ever read via `.has()` (never iterated or
 *  mutated — see its own doc comment), so two sets with identical membership
 *  are interchangeable for every consumer; reusing the OLD reference in that
 *  case is what lets memo'd GitTabBody/DiffContentPane skip a re-render. */
function sameSetContents(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const path of a) {
    if (!b.has(path)) return false
  }
  return true
}

/** PERF FIX (conflicted-paths identity) — apply a freshly-fetched conflict
 *  list via React's updater form so a same-contents result reuses the PREVIOUS
 *  Set identity instead of always committing a fresh one. `fetchConflicts`
 *  runs on every debounced settle (same tick as every diff refetch) even in
 *  the dominant no-conflict case, so without this a fresh (but
 *  content-identical) Set flows into memo'd GitTabBody/DiffContentPane every
 *  single file save, failing their shallow prop comparison and re-rendering
 *  the diff pane (re-running <PatchDiff>'s layout effect) for no reason. */
function setConflictedPathsIfChanged(
  setConflictedPaths: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>,
  paths: readonly string[]
): void {
  if (paths.length === 0) {
    setConflictedPaths((prev) => (prev.size === 0 ? prev : EMPTY_CONFLICTS))
    return
  }
  const next = new Set(paths)
  setConflictedPaths((prev) => (sameSetContents(prev, next) ? prev : next))
}

export function fetchConflicts(
  workspaceId: string,
  setConflictedPaths: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>
): void {
  window.api.git
    .conflicts(workspaceId)
    .then((paths) => setConflictedPathsIfChanged(setConflictedPaths, paths))
    .catch((e) => {
      console.error('[GitTab] git:conflicts failed:', e)
      setConflictedPathsIfChanged(setConflictedPaths, [])
    })
}
