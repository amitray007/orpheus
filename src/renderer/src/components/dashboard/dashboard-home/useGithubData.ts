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
import type { GhSearchIssue, GhSearchPr } from '@shared/types'

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
  possiblyUnavailable: false
}

function deriveState(
  prs: GhSearchPr[],
  issues: GhSearchIssue[],
  possiblyUnavailable: boolean
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
    possiblyUnavailable
  }
}

export function useGithubData(): GithubData {
  const [state, setState] = useState<Omit<GithubData, 'refresh'>>(EMPTY)
  const [nonce, setNonce] = useState(0)

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

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
            window.api.github.myIssuesCached()
          ])
          if (cancelled) return
          const [prsCached, issuesCached] = cached
          if (prsCached && issuesCached) {
            setState(deriveState(prsCached.value, issuesCached.value, false))
          }
        } catch {
          // Cached read is best-effort — the live fetch below is authoritative.
        }
      })()
    }

    async function loadFresh(): Promise<void> {
      try {
        const [prs, issues] = await Promise.all([
          window.api.github.myOpenPrs(),
          window.api.github.myIssues()
        ])
        if (cancelled) return
        setState(deriveState(prs, issues, prs.length === 0 && issues.length === 0))
      } catch (err: unknown) {
        if (!cancelled) {
          setState({
            ...EMPTY,
            loading: false,
            error: err instanceof Error ? err.message : 'Failed to load GitHub data'
          })
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
