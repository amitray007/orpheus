// ---------------------------------------------------------------------------
// PrTable — the "Open PRs" card (Dashboard Phase 2, U5). Renders REAL
// account-wide open PRs from `useGithubData` (backed by `gh search prs
// --author @me`), ordered by last push (updatedAt desc — the search API's
// own last-activity timestamp, used here as the "last push" proxy per the
// design spec). Replaces the SAMPLE_PR_ROWS shell render from U2.
//
// TWO-LINE rows (per the design spec's table design + this unit's brief):
//   Line 1: #number · title · checks chip (passing/failing/pending/none,
//     the defined 4-state set — never a blank cell) · draft chip when
//     `state === 'draft'`.
//   Line 2: repo (mono muted) · "pushed Nm/h/d ago" (formatCompactAge on
//     updatedAt).
// Row click opens the PR's GitHub url via `window.api.shell.openExternal`
// (new IPC, main-side guarded by isSafeExternalUrl — see src/main/ipc/
// shell.ts).
// ---------------------------------------------------------------------------

import { cn } from '@/lib/utils'
import type { GhSearchPr } from '@shared/types'
import { DashboardCard } from './DashboardCard'
import { useGithubData } from './useGithubData'
import { formatCompactAge } from './dashboardHome.helpers'

type ChecksState = GhSearchPr['checks'] // 'success' | 'failure' | 'pending' | null

const CHECK_LABEL: Record<'success' | 'failure' | 'pending' | 'none', string> = {
  success: '✓ passing',
  failure: '✕ failing',
  pending: '◷ pending',
  none: '— none'
}

// THEME RULE: checks chips use Orpheus tokens, not raw GitHub colors —
// passing/failing reuse the existing --color-gh-open/--color-gh-closed
// tokens (already the app's green/red convention for PR state, see
// DetailsTab.css), pending reuses --accent, none is a bare muted border.
// Correct in light + dark since every value is a token, not a literal hex.
const CHECK_CLASS: Record<'success' | 'failure' | 'pending' | 'none', string> = {
  success: 'text-[color:var(--color-gh-open)] bg-[color:var(--color-gh-open)]/12',
  failure: 'text-[color:var(--color-gh-closed)] bg-[color:var(--color-gh-closed)]/12',
  pending: 'text-accent bg-accent/12',
  none: 'text-text-muted border border-border-default'
}

function checksKey(checks: ChecksState): 'success' | 'failure' | 'pending' | 'none' {
  return checks ?? 'none'
}

function CheckChip({ checks }: { checks: ChecksState }): React.JSX.Element {
  const key = checksKey(checks)
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-[5px] px-1.5 py-0.5 font-mono text-[9px] whitespace-nowrap',
        CHECK_CLASS[key]
      )}
    >
      {CHECK_LABEL[key]}
    </span>
  )
}

function EmptyState({ hint }: { hint: boolean }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-10 text-center">
      <div className="text-[12.5px] font-medium text-text-primary">No open PRs</div>
      {hint ? (
        <div className="text-[11px] text-text-muted">
          GitHub unavailable — check that `gh` is installed and authenticated.
        </div>
      ) : null}
    </div>
  )
}

export function PrTable(): React.JSX.Element {
  const { loading, prs, openPrCount, draftPrCount, possiblyUnavailable } = useGithubData()

  const meta = loading
    ? 'loading…'
    : `${openPrCount} open${draftPrCount ? ` · ${draftPrCount} draft` : ''} · by last push`

  function openPr(url: string): void {
    void window.api.shell.openExternal(url)
  }

  return (
    <DashboardCard title="Open PRs" meta={meta}>
      {!loading && prs.length === 0 ? (
        <EmptyState hint={possiblyUnavailable} />
      ) : (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th className="w-[1%] border-b border-border-default px-2.5 pb-1.5 text-left font-mono text-[9.5px] tracking-wider text-text-muted uppercase">
                  #
                </th>
                <th className="border-b border-border-default px-2.5 pb-1.5 text-left font-mono text-[9.5px] tracking-wider text-text-muted uppercase">
                  Title
                </th>
                <th className="border-b border-border-default px-2.5 pb-1.5 text-right font-mono text-[9.5px] tracking-wider text-text-muted uppercase">
                  Pushed
                </th>
              </tr>
            </thead>
            <tbody>
              {prs.map((pr) => (
                <tr
                  key={`${pr.repo}#${pr.number}`}
                  onClick={() => openPr(pr.url)}
                  className="cursor-pointer align-top hover:bg-surface-overlay"
                >
                  {/* Single <td> per logical column spans both visual lines via
                      a flex-col wrapper, same two-line pattern as
                      LiveAgentsTable — line 2 (repo · pushed) always renders
                      here since every PR has a repo, unlike LiveAgents'
                      optional "doing" line. */}
                  <td className="border-b border-border-default px-2.5 py-2 align-top font-mono text-[10.5px] text-text-muted tabular-nums">
                    #{pr.number}
                  </td>
                  <td className="max-w-0 border-b border-border-default px-2.5 py-2 align-top">
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 truncate text-text-primary">{pr.title}</span>
                      <CheckChip checks={pr.checks} />
                      {pr.state === 'draft' ? (
                        <span className="shrink-0 rounded border border-border-default px-1 py-px font-mono text-[9px] tracking-wide text-text-muted uppercase">
                          draft
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[10.5px] whitespace-nowrap text-text-muted">
                      {pr.repo}
                    </div>
                  </td>
                  <td className="border-b border-border-default px-2.5 py-2 text-right align-top font-mono text-[10.5px] whitespace-nowrap text-text-muted tabular-nums">
                    {formatCompactAge(pr.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </DashboardCard>
  )
}
