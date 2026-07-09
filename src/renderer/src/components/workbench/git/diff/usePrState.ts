// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/diff/usePrState.ts
//
// GitTab Phase B extraction — the PR-DATA half of GitTab's state machine:
// pr/prDetail/reviewThreads/localReviews plus every effect that fetches them,
// EXCLUDING the pieces that are genuinely cross-concern (see below).
// Extracted per docs/learnings/gittab-state-machine.md §5's recommended
// boundary — read that doc before touching this file or GitTab.
//
// `diffMode` is taken as a plain parameter (not a ref) because the
// reviewThreads-fetch effect (spec §3.9) is keyed on it directly
// (`[workspaceId, diffMode, pr?.number]`) — a real effect dependency, not a
// "read latest value without re-subscribing" ref read. useGitDiffData still
// owns the `diffMode` STATE itself; this hook only reads the current value
// each render, exactly as GitTab's original single-component version did.
//
// What stays in GitTab.tsx (deliberately NOT moved here, see the spec's §6
// "MUST stay in GitTab" list):
//   - The workspace-change effect's PR-side resets — bundled into
//     `resetForWorkspaceChange()` below (a plain function GitTab calls at the
//     right point in its one ordered reset block), NOT an effect of its own.
//   - The `onPrChanged` subscription itself — its PR-loss cascade writes to
//     BOTH this hook's state (pr/prDetail/reviewThreads) AND
//     useGitDiffData's `diffMode` AND composer state, all in ONE synchronous
//     callback (the spec is explicit this must not split across two
//     `onPrChanged` subscriptions/effects). GitTab keeps the subscription;
//     this hook exposes the raw setters (`setPr`/`setPrDetail`/
//     `setReviewThreads`) plus `refetchReviewThreads`/`applyDiff`-adjacent
//     helpers that callback needs to call directly.
//   - The single combined `onStatusChanged` listener — this hook exposes
//     `scheduleRefreshPrDetail()` (the PR-only half) for GitTab's ONE shared
//     subscription to call; it does not set up its own listener (would
//     resurrect the exact two-listeners-on-one-event regression LAG-LAYER #9
//     fixed).
//   - `cleanupRef` — owned by useGitDiffData (passed through GitTab) rather
//     than duplicated here, since the invariant "only the latest in-flight
//     diff fetch may apply" spans both diff- and PR-side call sites (see
//     useGitDiffData's own header).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import type {
  GhPullRequest,
  GhPullRequestDetail,
  GhReviewCommentThread,
  LocalReviewComment
} from '@shared/types'
import type { CommentDraft, GhSubmitResult } from '../CommentComposer'
import type { DiffMode } from '../../GitTab'
import { fetchLocalReviews, fetchReviewComments } from './diffFetch'

// Same debounce constant as useGitDiffData's REFRESH_DEBOUNCE_MS — kept as a
// separate literal (not re-exported/shared) since `prDetailDebounceRef` was
// already its own independent timer from `debounceRef` pre-extraction (see
// GitTab's original "PERF FIX (LAG-LAYER #9)" comment: intentionally NOT
// folded into the diff-refetch timer, so prDetail refresh runs on its own
// cadence). The VALUE (130ms) must stay identical to useGitDiffData's.
const PR_DETAIL_REFRESH_DEBOUNCE_MS = 130

export interface UsePrStateResult {
  pr: GhPullRequest | null
  setPr: React.Dispatch<React.SetStateAction<GhPullRequest | null>>
  prDetail: GhPullRequestDetail | null
  setPrDetail: React.Dispatch<React.SetStateAction<GhPullRequestDetail | null>>
  reviewThreads: GhReviewCommentThread[] | null
  setReviewThreads: React.Dispatch<React.SetStateAction<GhReviewCommentThread[] | null>>
  localReviews: LocalReviewComment[]
  /** Latest `pr` without an effect dependency — read by the shared
   *  onStatusChanged callback's `scheduleRefreshPrDetail` (spec §6 point 4). */
  prRef: React.RefObject<GhPullRequest | null>
  refetchReviewThreads: () => void
  refetchLocalReviews: () => void
  refetchPrDetail: () => void
  submitGithubReviewComment: (draft: CommentDraft) => Promise<GhSubmitResult>
  submitLocalComment: (draft: CommentDraft) => Promise<GhSubmitResult>
  toggleLocalResolved: (comment: LocalReviewComment) => void
  deleteLocalComment: (comment: LocalReviewComment) => void
  /** The PR-only half of the shared onStatusChanged subscription (GitTab owns
   *  the actual subscription) — debounced on this hook's own timer, fires in
   *  BOTH diff modes (gated only on `prRef`, never on diffMode/diffModeRef). */
  scheduleRefreshPrDetail: () => void
  /** The prDetail-refresh debounce timer handle. Exposed so GitTab's shared
   *  onStatusChanged subscription cleanup can clear it on teardown (workspace
   *  switch) — same as `debounceRef` from useGitDiffData. Without this a stale
   *  workspace's pending prDetail refresh could fire ~130ms after a rapid
   *  switch and clobber the new workspace's prDetail (spec §6 items 2/16). */
  prDetailDebounceRef: React.RefObject<ReturnType<typeof setTimeout> | null>
  /** GitTab's single workspace-change effect calls this at the exact point
   *  in its ordered reset sequence — bundles this hook's own reset slice
   *  (pr/prDetail/reviewThreads -> null, localReviews -> []) plus the
   *  unconditional fetchLocalReviews for the new workspace. Takes
   *  `workspaceId` explicitly since it fires with the NEW workspaceId that
   *  triggered the reset (same value the hook itself is about to receive as
   *  its own `workspaceId` argument on the next render). */
  resetForWorkspaceChange: (workspaceId: string) => void
}

/** The PR-data half of GitTab's state machine — see this module's header for
 *  the extraction boundary and what deliberately stayed in GitTab.
 *
 *  @param workspaceId Current workspace.
 *  @param diffMode Current diff mode (owned by useGitDiffData) — the
 *    reviewThreads-fetch effect (spec §3.9) is keyed on this value directly.
 *  @param closeComposer From `useReviewComposers()` (GitTab-owned; composer
 *    state is a third concern neither hook owns outright — see the spec).
 *  @param pendingCommitId Resolver for the PR's head commit sha (from
 *    `prDetail.commits`), needed by `submitGithubReviewComment` — kept as a
 *    plain derivation INSIDE this hook (reads `prDetail` state it already
 *    owns) rather than a parameter, since `prDetail` lives here.
 */
export function usePrState(
  workspaceId: string,
  diffMode: DiffMode,
  closeComposer: (id: string) => void
): UsePrStateResult {
  const [pr, setPr] = useState<GhPullRequest | null>(null)
  const [prDetail, setPrDetail] = useState<GhPullRequestDetail | null>(null)
  const [reviewThreads, setReviewThreads] = useState<GhReviewCommentThread[] | null>(null)
  const [localReviews, setLocalReviews] = useState<LocalReviewComment[]>([])

  // Fetch-on-mount fallback for `pr` (spec §3.7) — unchanged, just relocated.
  // See GitTab's original doc comment for the full root-cause writeup:
  // `startGitWatch`'s initial `github:prChanged` push is a one-shot event
  // that almost always fires before this hook mounts, so this direct fetch
  // covers the gap the onPrChanged subscription (GitTab-owned) alone can't.
  useEffect(() => {
    let cancelled = false
    window.api.github
      .prForWorkspace(workspaceId)
      .then((fetchedPr) => {
        if (cancelled) return
        // Race guard (unchanged): never let this slower fetch clobber an
        // already-set non-null `pr` back to null — onPrChanged's live push
        // may resolve first and win.
        setPr((prev) => (prev !== null && fetchedPr === null ? prev : fetchedPr))
      })
      .catch((e) => {
        console.error('[GitTab] github:prForWorkspace failed:', e)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  // `prRef` (spec §2) — mirror of `pr`, read by the shared onStatusChanged
  // callback's `scheduleRefreshPrDetail` below without an effect dependency
  // on `pr` itself.
  const prRef = useRef(pr)
  useEffect(() => {
    prRef.current = pr
  }, [pr])

  const prDetailDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The PR-only half of the shared live-refresh subscription (spec §3.6) —
  // GitTab's single onStatusChanged listener calls this directly (same
  // "GitTab owns subscription + teardown timing" rationale as
  // useGitDiffData's scheduleRefetch — GitTab's subscription effect clears
  // `prDetailDebounceRef`, exposed below, in its own cleanup).
  const scheduleRefreshPrDetail = useCallback((): void => {
    if (prRef.current === null) return
    if (prDetailDebounceRef.current !== null) clearTimeout(prDetailDebounceRef.current)
    prDetailDebounceRef.current = setTimeout(() => {
      prDetailDebounceRef.current = null
      window.api.github
        .prDetail(workspaceId)
        .then(setPrDetail)
        .catch((e2) => console.error('[GitTab] github:prDetail refresh failed:', e2))
    }, PR_DETAIL_REFRESH_DEBOUNCE_MS)
  }, [workspaceId])

  // ReviewThreads-fetch effect (spec §3.9) — unchanged logic/guard, just
  // relocated. `reviewThreadsClearedRef` guards the "clear" branch's setState
  // so it's not an unconditional top-of-effect call (react-hooks/
  // set-state-in-effect flags that shape) — see the ref's own doc comment in
  // the original GitTab for the full rationale.
  const reviewThreadsClearedRef = useRef(true)
  useEffect(() => {
    if (diffMode !== 'pr' || pr === null) {
      if (!reviewThreadsClearedRef.current) {
        reviewThreadsClearedRef.current = true
        setReviewThreads(null)
      }
      return undefined
    }
    reviewThreadsClearedRef.current = false
    let cancelled = false
    window.api.github
      .prReviewComments(workspaceId)
      .then((threads) => {
        if (!cancelled) setReviewThreads(threads)
      })
      .catch((e) => {
        console.error('[GitTab] github:prReviewComments failed:', e)
        if (!cancelled) setReviewThreads(null)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed on the PRIMITIVE pr?.number rather than the whole `pr` object, same rationale as the prDetail-fetch effect below: onPrChanged (GitTab) may push a referentially-new-but-equal PR on every branch-watch tick, and this effect must not refetch on those no-op pushes.
  }, [workspaceId, diffMode, pr?.number])

  // PrDetail-fetch effect (spec §3.10) — unchanged, just relocated.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed on the PRIMITIVE pr?.number/pr?.state rather than the whole `pr` object: onPrChanged (GitTab) may push a referentially-new-but-equal PR on every branch-watch tick, and this effect must not refetch prDetail on those no-op pushes.
  }, [workspaceId, pr?.number, pr?.state])

  const refetchReviewThreads = useCallback(() => {
    fetchReviewComments(workspaceId, setReviewThreads)
  }, [workspaceId])

  const refetchLocalReviews = useCallback(() => {
    fetchLocalReviews(workspaceId, setLocalReviews)
  }, [workspaceId])

  const refetchPrDetail = useCallback(() => {
    window.api.github
      .prDetail(workspaceId)
      .then(setPrDetail)
      .catch((e) => console.error('[GitTab] github:prDetail refetch failed:', e))
  }, [workspaceId])

  // Posts a NEW line-anchored review comment for real, via
  // github:postReviewComment (unchanged, just relocated) — see GitTab's
  // original doc comment for the headOid/commits[length-1] rationale.
  const submitGithubReviewComment = useCallback(
    async (draft: CommentDraft): Promise<GhSubmitResult> => {
      const headOid = prDetail?.commits[prDetail.commits.length - 1]?.oid
      const result = await window.api.github.postReviewComment({
        workspaceId,
        path: draft.path,
        line: draft.line,
        side: draft.side,
        body: draft.body,
        commitId: headOid
      })
      if (!result.ok) return result
      closeComposer(draft.id)
      refetchReviewThreads()
      return { ok: true }
    },
    [workspaceId, prDetail, closeComposer, refetchReviewThreads]
  )

  // Saves a NEW comment to the LOCAL store (unchanged, just relocated).
  const submitLocalComment = useCallback(
    async (draft: CommentDraft): Promise<GhSubmitResult> => {
      try {
        await window.api.reviews.add({
          workspaceId,
          prNumber: pr?.number ?? null,
          path: draft.path,
          line: draft.line,
          startLine: draft.startLine ?? null,
          side: draft.side,
          body: draft.body
        })
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
      closeComposer(draft.id)
      refetchLocalReviews()
      return { ok: true }
    },
    [workspaceId, pr, closeComposer, refetchLocalReviews]
  )

  const toggleLocalResolved = useCallback(
    (comment: LocalReviewComment) => {
      window.api.reviews
        .setResolved(comment.id, !comment.resolved)
        .then(refetchLocalReviews)
        .catch((e) => console.error('[GitTab] reviews:setResolved failed:', e))
    },
    [refetchLocalReviews]
  )

  const deleteLocalComment = useCallback(
    (comment: LocalReviewComment) => {
      window.api.reviews
        .delete(comment.id)
        .then(refetchLocalReviews)
        .catch((e) => console.error('[GitTab] reviews:delete failed:', e))
    },
    [refetchLocalReviews]
  )

  // GitTab's workspace-change effect calls this (with the NEW workspaceId)
  // at the precise point in its ordered reset sequence — bundles this hook's
  // PR-side reset slice (steps 6-9 of spec §3.2) plus the unconditional
  // fetchLocalReviews call (localReviews has no PR dependency, same as the
  // pre-extraction version).
  const resetForWorkspaceChange = useCallback((nextWorkspaceId: string) => {
    setPr(null)
    setPrDetail(null)
    setReviewThreads(null)
    setLocalReviews([])
    fetchLocalReviews(nextWorkspaceId, setLocalReviews)
  }, [])

  return {
    pr,
    setPr,
    prDetail,
    setPrDetail,
    reviewThreads,
    setReviewThreads,
    localReviews,
    prRef,
    refetchReviewThreads,
    refetchLocalReviews,
    refetchPrDetail,
    submitGithubReviewComment,
    submitLocalComment,
    toggleLocalResolved,
    deleteLocalComment,
    scheduleRefreshPrDetail,
    prDetailDebounceRef,
    resetForWorkspaceChange
  }
}
