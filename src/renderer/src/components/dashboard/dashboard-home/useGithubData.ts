// ---------------------------------------------------------------------------
// useGithubData — Dashboard Phase 2 (U5), stale-while-revalidate (D2).
// Fetches account-wide GitHub PRs + issues (`window.api.github.myOpenPrs`/
// `myIssues`) for the Open-PRs/Issues tables and their triage-tile counts.
//
// Stale-while-revalidate: on mount, a disk-backed cached read
// (`myOpenPrsCached`/`myIssuesCached`) and the live network fetch both kick
// off in parallel. Whichever resolves first paints the screen — if the
// cache has a row, the UI paints INSTANTLY with `loading: false` and no
// skeleton; the live fetch then lands and silently overwrites state with
// fresh data (no flash, no layout jump). `loading` is only ever true on a
// genuine first-ever load: no cache row AND the fresh fetch hasn't landed
// yet. A manual `refresh()` never resets to skeleton and never blanks the
// current data — it re-fires only the live fetch and swaps in silently when
// it lands, exactly like the mount revalidation.
//
// Both `window.api.github.myOpenPrs()`/`myIssues()` are TOTAL (never reject)
// per github.ts's contract — any gh failure (missing/unauth/network)
// resolves to `[]`, not a thrown error. `error` here is therefore only ever
// set by a genuine IPC-layer failure (renderer/main bridge broken), not by
// an ordinary "gh not installed" case — that case instead surfaces as both
// lists being empty with `error === null`, which the tables render as their
// normal empty state, and DashboardView surfaces as a calm "GitHub
// unavailable" hint (see ghUnavailable below) rather than a hard error.
// `possiblyUnavailable` is always computed from the FRESH result, never the
// cached one, so a stale cache doesn't misreport availability.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from 'react'
import type { GhSearchIssue, GhSearchPr, GithubAccountSnapshot } from '@shared/types'

export interface GithubData {
  loading: boolean
  error: string | null
  prs: GhSearchPr[]
  issues: GhSearchIssue[]
  /** Open PR count including drafts (prs.length). */
  openPrCount: number
  /** Draft subcount within openPrCount, for the "· N draft" sublabel. */
  draftPrCount: number
  openIssueCount: number
  /** True once the first FRESH fetch has completed and BOTH lists came back
   *  empty with no IPC error — the ambiguous "gh not installed/unauth" vs.
   *  "genuinely zero open PRs/issues" case. DashboardView uses this to show
   *  a subtle hint without blocking or erroring the rest of the page. */
  possiblyUnavailable: boolean
  snapshot: GithubAccountSnapshot | null
  refreshing: boolean
  refreshError: string | null
  refresh: () => void
}

const EMPTY: Omit<GithubData, 'refresh'> = {
  loading: true,
  error: null,
  prs: [],
  issues: [],
  openPrCount: 0,
  draftPrCount: 0,
  openIssueCount: 0,
  possiblyUnavailable: false,
  snapshot: null,
  refreshing: false,
  refreshError: null
}

function deriveState(
  prs: GhSearchPr[],
  issues: GhSearchIssue[],
  possiblyUnavailable: boolean,
  snapshot: GithubAccountSnapshot | null
): Omit<GithubData, 'refresh'> {
  const draftPrCount = prs.filter((pr) => pr.state === 'draft').length
  return {
    loading: false,
    error: null,
    prs,
    issues,
    openPrCount: prs.length,
    draftPrCount,
    openIssueCount: issues.length,
    possiblyUnavailable,
    snapshot,
    refreshing: false,
    refreshError: null
  }
}

function unavailableMessage(snapshot: GithubAccountSnapshot): string {
  if (snapshot.unavailableReason === 'gh-not-found') return 'GitHub CLI is not installed'
  if (snapshot.unavailableReason === 'not-authenticated') return 'GitHub CLI is not signed in'
  return 'GitHub data is unavailable'
}

function mergeGithubSnapshot(
  current: GithubAccountSnapshot | null,
  next: GithubAccountSnapshot
): { snapshot: GithubAccountSnapshot; retainedStaleSection: boolean } {
  if (!current || current.availability === 'unavailable') {
    return { snapshot: next, retainedStaleSection: false }
  }
  if (next.availability === 'unavailable') {
    return { snapshot: current, retainedStaleSection: true }
  }
  let retainedStaleSection = false
  const keepRepositories =
    next.repositoriesStatus === 'unavailable' && current.repositoriesStatus === 'available'
  const keepWorkflowRuns =
    next.workflowRunsStatus === 'unavailable' &&
    current.workflowRunsStatus === 'available' &&
    next.workflowScope.repositories.length === current.workflowScope.repositories.length &&
    next.workflowScope.repositories.every(
      (repository, index) => repository === current.workflowScope.repositories[index]
    )
  const keepActivity =
    next.activityStatus === 'unavailable' && current.activityStatus === 'available'
  retainedStaleSection = keepRepositories || keepWorkflowRuns || keepActivity
  return {
    snapshot: {
      ...next,
      reviewRequestedCount:
        next.reviewRequestedCount ??
        (keepActivity ? current.reviewRequestedCount : next.reviewRequestedCount),
      repositories: keepRepositories ? current.repositories : next.repositories,
      workflowRuns: keepWorkflowRuns ? current.workflowRuns : next.workflowRuns,
      activity7d: keepActivity ? current.activity7d : next.activity7d
    },
    retainedStaleSection
  }
}

export function useGithubData(): GithubData {
  const [state, setState] = useState<Omit<GithubData, 'refresh'>>(EMPTY)
  const [nonce, setNonce] = useState(0)

  const refresh = useCallback(() => {
    setState((current) => ({ ...current, refreshing: true, refreshError: null }))
    setNonce((n) => n + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    const isRefresh = nonce > 0

    // On manual refresh, skip the cached read (the user explicitly wants
    // fresh data) and never blank the current data — only the live fetch
    // below runs, swapping state in silently when it lands.
    if (!isRefresh) {
      void (async (): Promise<void> => {
        try {
          const cached = await Promise.all([
            window.api.github.myOpenPrsCached(),
            window.api.github.myIssuesCached(),
            window.api.github.accountSnapshotCached()
          ])
          if (cancelled) return
          const [prsCached, issuesCached, accountCached] = cached
          if (prsCached && issuesCached) {
            setState(
              deriveState(prsCached.value, issuesCached.value, false, accountCached?.value ?? null)
            )
          } else if (accountCached) {
            setState((current) => ({
              ...current,
              loading: false,
              snapshot: accountCached.value
            }))
          }
        } catch {
          // Cached read is best-effort — the live fetch below is authoritative.
        }
      })()
    }

    async function loadFresh(): Promise<void> {
      try {
        const [prs, issues, snapshot] = await Promise.all([
          window.api.github.myOpenPrs(isRefresh),
          window.api.github.myIssues(isRefresh),
          window.api.github.accountSnapshot(isRefresh)
        ])
        if (cancelled) return
        setState((current) => {
          const merged = mergeGithubSnapshot(current.snapshot, snapshot)
          const keepLastGood = snapshot.availability === 'unavailable' && current.snapshot !== null
          const next = deriveState(
            keepLastGood ? current.prs : prs,
            keepLastGood ? current.issues : issues,
            snapshot.availability === 'unavailable',
            merged.snapshot
          )
          if (keepLastGood) return { ...next, refreshError: unavailableMessage(snapshot) }
          return merged.retainedStaleSection
            ? { ...next, refreshError: 'Some GitHub data could not be refreshed' }
            : next
        })
      } catch (err: unknown) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'Failed to load GitHub data'
          setState((current) => ({
            ...current,
            loading: false,
            refreshing: false,
            error: current.snapshot ? current.error : message,
            refreshError: current.snapshot ? message : null
          }))
        }
      }
    }

    void loadFresh()
    return () => {
      cancelled = true
    }
  }, [nonce])

  return { ...state, refresh }
}
