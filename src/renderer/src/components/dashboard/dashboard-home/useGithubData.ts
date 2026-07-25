import { refreshHomeSource } from '../home/homeFacade'
import { useHomeSnapshot } from '../home/useHomeSnapshot'

export interface GithubData {
  loading: boolean
  error: string | null
  prs: ReturnType<typeof useHomeSnapshot>['github']['data']['prs']
  issues: ReturnType<typeof useHomeSnapshot>['github']['data']['issues']
  openPrCount: number
  draftPrCount: number
  openIssueCount: number
  possiblyUnavailable: boolean
  refresh: () => void
}

/** Compatibility selector for the legacy dashboard. Fetch ownership lives in
 * the shared Home facade, so mounting this beside Home pages cannot duplicate
 * GitHub reads. */
export function useGithubData(): GithubData {
  const source = useHomeSnapshot().github
  const prs = source.data.prs
  const issues = source.data.issues
  const possiblyUnavailable =
    !source.loading &&
    !source.refreshing &&
    !source.stale &&
    !source.error &&
    !source.unavailable &&
    source.fetchedAt !== undefined &&
    prs.length === 0 &&
    issues.length === 0
  return {
    loading: source.loading,
    error: source.error,
    prs,
    issues,
    openPrCount: prs.length,
    draftPrCount: prs.filter((pr) => pr.state === 'draft').length,
    openIssueCount: issues.length,
    // The current GitHub bridge intentionally cannot distinguish a fresh,
    // empty account from an unavailable gh installation.
    possiblyUnavailable,
    refresh: () => refreshHomeSource('github')
  }
}
