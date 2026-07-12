// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/diff/useGitDiffData.ts
//
// GitTab Phase B extraction — the DIFF-DATA half of GitTab's state machine:
// files/repo/loading/selectedPath/diffStyle/diffMode/conflictedPaths/branch/
// git-init, plus every effect that ONLY concerns the diff itself (not PR
// data). Extracted per docs/learnings/gittab-state-machine.md §5's
// recommended boundary — read that doc before touching this file or GitTab.
//
// What stays in GitTab.tsx (deliberately NOT moved here, see the spec's §6
// "MUST stay in GitTab" list):
//   - The workspace-change effect (3.2) — it resets BOTH diff- and PR-side
//     state (plus composers) in one synchronous, precisely-ordered block,
//     immediately followed by the forceFresh initial fetch. This hook
//     exposes `resetForWorkspaceChange()` (a plain function, not an effect)
//     bundling exactly this hook's own slice of that reset (files/
//     selectedPath/diffMode/gitInitError/lastAppliedSigRef/
//     lastFetchedModeForWorkspaceRef/conflictedPaths) so GitTab's single
//     workspace-change effect can call it at the exact point in the ordered
//     sequence the spec requires, immediately before firing the initial
//     fetchDiff itself (also still owned by GitTab, since it must run AFTER
//     usePrState's own reset slice too).
//   - The single combined `onStatusChanged`/`onFilesChanged` subscription —
//     this hook exposes `scheduleRefetch()` (the diff-only half) for that one
//     shared subscription (in GitTab) to call; it does NOT set up its own
//     `onStatusChanged` listener (that would resurrect the exact
//     two-listeners-on-one-event perf regression LAG-LAYER #9 fixed).
//   - `cleanupRef` — shared across THIS hook's own debounced refetch/
//     runGitInit call sites AND `onPrChanged`'s PR-diff-mode refetch (GitTab).
//     Exposed from this hook (not GitTab-local) since two of its three call
//     sites live here; GitTab reads it via the returned ref for its third.
//   - `resetComposers` is a parameter (not owned here) — composer state is a
//     third concern this hook only needs write-access to reset from the
//     mode-switch effect.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { GitDiffFile } from '@shared/types'
import type { DiffStyle, DiffMode } from '../../GitTab'
import {
  fetchConflicts,
  fetchDiff,
  fetchForMode,
  diffSignature,
  nextSelection,
  EMPTY_CONFLICTS,
  type DiffSettleResult
} from './diffFetch'

// Live-refresh debounce — see GitTab.tsx's own REFRESH_DEBOUNCE_MS comment
// for the full perf-history writeup (files:changed fast path + idempotent
// applyDiff no-op). Kept identical here (130ms) — this constant moved, its
// value/rationale did not.
const REFRESH_DEBOUNCE_MS = 130

export interface UseGitDiffDataResult {
  files: GitDiffFile[]
  repo: boolean
  loading: boolean
  /** GitTab's own workspace-change effect fires the FIRST forceFresh fetch
   *  itself (see this module's header on why that fetch stays in GitTab, not
   *  inside `resetForWorkspaceChange`) and needs to clear `loading` from its
   *  own `fetchDiff` callback, same as the pre-extraction version did. */
  setLoading: (loading: boolean) => void
  selectedPath: string | null
  setSelectedPath: (path: string | null) => void
  diffStyle: DiffStyle
  setDiffStyle: (style: DiffStyle) => void
  diffMode: DiffMode
  setDiffMode: (mode: DiffMode | ((prev: DiffMode) => DiffMode)) => void
  /** Latest `diffMode` without an effect dependency — read by GitTab's shared
   *  onStatusChanged/onPrChanged callbacks and by `submitComment`'s
   *  dispatcher (see the spec's §6 point 3 on why this ref itself, not just
   *  the state value, must be exposed). */
  diffModeRef: React.RefObject<DiffMode>
  conflictedPaths: ReadonlySet<string>
  branch: string | null
  setBranch: (branch: string | null) => void
  gitInitRunning: boolean
  gitInitError: string | null
  runGitInit: () => void
  /** The idempotent apply-a-settled-diff callback (see diffFetch.ts's
   *  diffSignature doc comment) — GitTab's shared onPrChanged callback also
   *  calls fetchPrDiff(..., applyDiff) directly for the "PR changed while
   *  already in PR-diff mode" case, so this must be exposed, not hidden. */
  applyDiff: (result: DiffSettleResult) => void
  /** Shared `cleanupRef` — see this module's header. GitTab's onPrChanged
   *  callback also reads/writes this for its own PR-diff refetch call site. */
  cleanupRef: React.RefObject<(() => void) | null>
  /** The debounce-timer ref `scheduleRefetch` schedules onto — GitTab's
   *  shared subscription effect clears this in its own cleanup (see this
   *  module's header on why that teardown isn't a separate effect here). */
  debounceRef: React.RefObject<ReturnType<typeof setTimeout> | null>
  /** The diff-only half of the shared onStatusChanged/onFilesChanged
   *  subscription (GitTab owns the actual subscription — see this module's
   *  header on why it isn't set up here). Gated on `diffModeRef.current ===
   *  'working'`; debounced on this hook's own `debounceRef`; also refreshes
   *  `conflictedPaths` on the same tick. */
  scheduleRefetch: () => void
  /** GitTab's single workspace-change effect calls this at the exact point
   *  in its ordered reset sequence (see this module's header) — bundles this
   *  hook's own slice of the reset (NOT the fetch itself, which GitTab fires
   *  afterward once usePrState's slice has also run). */
  resetForWorkspaceChange: () => void
}

/** The diff-data half of GitTab's state machine — see this module's header
 *  for the extraction boundary and what deliberately stayed in GitTab. */
export function useGitDiffData(
  workspaceId: string,
  resetComposers: () => void
): UseGitDiffDataResult {
  const [files, setFiles] = useState<GitDiffFile[]>([])
  const [conflictedPaths, setConflictedPaths] = useState<ReadonlySet<string>>(EMPTY_CONFLICTS)
  const [repo, setRepo] = useState(true)
  const [loading, setLoading] = useState(true)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [diffStyle, setDiffStyle] = useState<DiffStyle>('unified')
  const [diffMode, setDiffMode] = useState<DiffMode>('working')
  const [branch, setBranch] = useState<string | null>(null)
  const [gitInitRunning, setGitInitRunning] = useState(false)
  const [gitInitError, setGitInitError] = useState<string | null>(null)

  // See GitTab's original applyDiff comment (unchanged, just relocated) —
  // idempotent-by-signature settle + the stuck-loading fix's `unchanged`
  // hard no-op.
  const lastAppliedSigRef = useRef<string | null>(null)
  const applyDiff = useCallback((result: DiffSettleResult) => {
    if (result.unchanged) return
    const sig = diffSignature(result)
    if (sig === lastAppliedSigRef.current) return
    lastAppliedSigRef.current = sig
    setRepo(result.repo)
    setFiles(result.files)
    setSelectedPath((prev) => nextSelection(result.files, prev))
  }, [])

  const lastFetchedModeForWorkspaceRef = useRef<DiffMode>('working')

  // Mode-switch effect (spec §3.3) — unchanged logic/ordering, just
  // relocated. Deliberately does NOT reset pr/prDetail/subTab (those live in
  // GitTab/usePrState) — only the diff data itself changes on a mode flip.
  useEffect(() => {
    if (lastFetchedModeForWorkspaceRef.current === diffMode) return undefined
    lastFetchedModeForWorkspaceRef.current = diffMode
    setLoading(true)
    setFiles([])
    setSelectedPath(null)
    resetComposers()
    lastAppliedSigRef.current = null
    setConflictedPaths(new Set())
    if (diffMode !== 'pr') fetchConflicts(workspaceId, setConflictedPaths)
    return fetchForMode(
      diffMode,
      workspaceId,
      (result) => {
        applyDiff(result)
        setLoading(false)
      },
      { forceFresh: true }
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- workspaceId intentionally excluded: this effect's guard already re-derives correctly on a workspace change (GitTab's workspace-change effect sets the ref to 'working' in the same tick it resets diffMode to 'working' via resetForWorkspaceChange below, so this effect sees a no-op match and skips, exactly as intended).
  }, [diffMode])

  // Working-tree watcher (spec §3.4) — unchanged, just relocated.
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

  // diffModeRef sync (spec §3.5) — unchanged, just relocated.
  const diffModeRef = useRef(diffMode)
  useEffect(() => {
    diffModeRef.current = diffMode
  }, [diffMode])

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)

  // The diff-only half of the shared live-refresh subscription (spec §3.6) —
  // GitTab's single onStatusChanged/onFilesChanged listener calls this
  // directly; it is NOT its own subscription, and its timer/cleanupRef
  // teardown is NOT its own effect either (see this module's header) — both
  // are owned by GitTab's single combined subscription effect (deps
  // `[workspaceId, applyDiff, ...]`), which clears `debounceRef`/`cleanupRef`
  // (read via this hook's returned refs) in its OWN cleanup, exactly matching
  // the pre-extraction single-effect's teardown timing. Giving this hook its
  // own SEPARATE cleanup effect here (keyed only on `[workspaceId]`, since
  // `applyDiff`'s identity is stable/empty-deps) would tear down out of step
  // with GitTab's subscription effect on a re-subscribe, so it deliberately
  // does not exist.
  const scheduleRefetch = useCallback((): void => {
    if (diffModeRef.current !== 'working') return
    if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null
      cleanupRef.current?.()
      cleanupRef.current = fetchDiff(workspaceId, applyDiff)
      fetchConflicts(workspaceId, setConflictedPaths)
    }, REFRESH_DEBOUNCE_MS)
  }, [workspaceId, applyDiff])

  // Git-init runner (spec §3.11) — unchanged, just relocated.
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

  // GitTab's workspace-change effect calls this at the precise point in its
  // ordered sequence (see this module's header + GitTab's own comment) —
  // bundles this hook's diff-only reset slice (steps 2-4, 13, 14, 16 of spec
  // §3.2), NOT the fetch itself (GitTab fires that once usePrState's own
  // reset slice has also run, matching the original single-effect order).
  const resetForWorkspaceChange = useCallback(() => {
    setLoading(true)
    setFiles([])
    setSelectedPath(null)
    setGitInitError(null)
    setDiffMode('working')
    setConflictedPaths(new Set())
    lastAppliedSigRef.current = null
    lastFetchedModeForWorkspaceRef.current = 'working'
    fetchConflicts(workspaceId, setConflictedPaths)
  }, [workspaceId])

  return {
    files,
    repo,
    loading,
    setLoading,
    selectedPath,
    setSelectedPath,
    diffStyle,
    setDiffStyle,
    diffMode,
    setDiffMode,
    diffModeRef,
    conflictedPaths,
    branch,
    setBranch,
    gitInitRunning,
    gitInitError,
    runGitInit,
    applyDiff,
    cleanupRef,
    debounceRef,
    scheduleRefetch,
    resetForWorkspaceChange
  }
}
