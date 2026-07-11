// ---------------------------------------------------------------------------
// useGithubData — Dashboard Phase 2 (U5). Fetches account-wide GitHub PRs +
// issues (`window.api.github.myOpenPrs`/`myIssues`) for the Open-PRs/Issues
// tables and their triage-tile counts. Mirrors useLiveAgents.ts's shape
// (loading/error/rows) but adds a manual `refresh()` — unlike live agents,
// this data is server-cached (60s TTL in github.ts) and has no push channel,
// so a manual refresh is the only way to force a re-fetch before the TTL
// naturally expires.
//
// Both `window.api.github.myOpenPrs()`/`myIssues()` are TOTAL (never reject)
// per github.ts's contract — any gh failure (missing/unauth/network)
// resolves to `[]`, not a thrown error. `error` here is therefore only ever
// set by a genuine IPC-layer failure (renderer/main bridge broken), not by
// an ordinary "gh not installed" case — that case instead surfaces as both
// lists being empty with `error === null`, which the tables render as their
// normal empty state, and DashboardView surfaces as a calm "GitHub
// unavailable" hint (see ghUnavailable below) rather than a hard error.
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
  /** True once the first fetch has completed and BOTH lists came back empty
   *  with no IPC error — the ambiguous "gh not installed/unauth" vs.
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

export function useGithubData(): GithubData {
  const [state, setState] = useState<Omit<GithubData, 'refresh'>>(EMPTY)
  const [nonce, setNonce] = useState(0)

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false

    async function load(): Promise<void> {
      setState((prev) => ({ ...prev, loading: true }))
      try {
        const [prs, issues] = await Promise.all([
          window.api.github.myOpenPrs(),
          window.api.github.myIssues()
        ])
        if (cancelled) return

        const draftPrCount = prs.filter((pr) => pr.state === 'draft').length

        setState({
          loading: false,
          error: null,
          prs,
          issues,
          openPrCount: prs.length,
          draftPrCount,
          openIssueCount: issues.length,
          possiblyUnavailable: prs.length === 0 && issues.length === 0
        })
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

    void load()
    return () => {
      cancelled = true
    }
  }, [nonce])

  return { ...state, refresh }
}
