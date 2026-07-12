// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/diff/hunkRevert.ts
//
// Per-hunk "Revert" on the working-tree diff (setting-gated, AppUiState.
// hunkActionsEnabled — see docs/learnings/hunk-accept-reject.md, the
// researched spec this implements verbatim). Reverts ONE hunk of a file's
// patch back to its HEAD content by computing the resulting full file text
// with @pierre/diffs' processFile + diffAcceptRejectHunk, then writing it
// back via the existing files:writeFile IPC. Never touches git/the index —
// this is a pure file-content transform, closer to a merge-conflict
// resolver's "undo this hunk" than to `git add -p`.
//
// hunkIndexForLine — maps a hovered gutter line (from renderGutterUtility's
// getHoveredLine) to its owning hunk, via a CHEAP parse of `file.patch` alone
// (no oldFile/newFile — isPartial:true is fine here since only
// hunks[].additionStart/additionCount are read, and those come straight from
// the `@@` header regardless of isPartial — verified against the installed
// @pierre/diffs 1.2.12).
//
// revertHunk — the mutating action: fetches HEAD content (git:showHead) +
// current on-disk content (files:readFile) FRESH at call time (mitigates the
// TOCTOU window the research doc calls out — §4's freshness note), parses a
// SECOND, full FileDiffMetadata with isPartial:false, calls
// diffAcceptRejectHunk(diff, hunkIndex, 'reject'), and writes
// `.additionLines.join('')` back. Distinguishes a legitimate empty result
// (an untracked file's only hunk reverts to nothing — §2 point 3 of the
// research) from a computation failure — only the latter throws.
// ---------------------------------------------------------------------------

import { processFile, diffAcceptRejectHunk } from '@pierre/diffs'
import type { GitDiffFile } from '@shared/types'

/** Maps a hovered line (Pierre's `{ lineNumber, side }`) to the index of the
 *  hunk it belongs to, or `null` if no hunk claims it (shouldn't happen for a
 *  line actually rendered inside a hunk, but the gutter utility can fire for
 *  lines outside any hunk in edge cases — e.g. a file with zero hunks). Only
 *  the ADDITION side's line numbers are considered: a hunk's `additionStart`/
 *  `additionCount` describe the new-file line range it occupies, which is
 *  the only side the working tree can be reverted TO reference against
 *  (matches the whole-hunk-only v1 scope — see the research's §2 point 4 on
 *  why changeIndex-level granularity is deferred). */
export function hunkIndexForLine(patch: string, lineNumber: number): number | null {
  const diff = processFile(patch, { isGitDiff: true })
  if (!diff) return null
  for (let i = 0; i < diff.hunks.length; i++) {
    const hunk = diff.hunks[i]
    const start = hunk.additionStart
    const end = start + hunk.additionCount - 1
    if (lineNumber >= start && lineNumber <= end) return i
  }
  return null
}

export type RevertHunkResult = { ok: true; emptied: boolean } | { ok: false; error: string }

/** Reverts hunk `hunkIndex` of `file` to its HEAD content and writes the
 *  resulting file text back to disk. `emptied: true` on success signals the
 *  "legitimate empty file" case (an untracked file's only hunk, or a file
 *  whose entire content was one hunk) — distinct from `ok: false`, which
 *  means the computation itself failed and NOTHING was written. */
export async function revertHunk(
  workspaceId: string,
  file: GitDiffFile,
  hunkIndex: number
): Promise<RevertHunkResult> {
  try {
    const [headContent, current] = await Promise.all([
      window.api.git.showHead(workspaceId, file.path),
      window.api.files.readFile(workspaceId, file.path)
    ])
    if (current.binary) {
      return { ok: false, error: 'Cannot revert a binary file' }
    }
    const oldFile = { name: file.path, contents: headContent ?? '' }
    const newFile = { name: file.path, contents: current.contents }
    const diff = processFile(file.patch, { isGitDiff: true, oldFile, newFile })
    if (!diff || diff.isPartial) {
      return { ok: false, error: 'Could not parse this diff' }
    }
    if (hunkIndex < 0 || hunkIndex >= diff.hunks.length) {
      return { ok: false, error: 'This hunk no longer exists — the file may have changed' }
    }
    const resolved = diffAcceptRejectHunk(diff, hunkIndex, 'reject')
    const newText = resolved.additionLines.join('')
    const result = await window.api.files.writeFile(workspaceId, file.path, newText)
    if (!result.ok) {
      return { ok: false, error: `Could not write file: ${result.error}` }
    }
    return { ok: true, emptied: newText.length === 0 }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
