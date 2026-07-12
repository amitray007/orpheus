// ---------------------------------------------------------------------------
// UsageLimitsCard — content for the "Usage" pulse panel, which V1's
// DashboardView now wraps in `<DashboardCard variant="primary">` (the ONE
// focal/emphasized panel in the pulse row per dashboard-v3.html's
// `.panel.primary`) — this file only renders the meters, the accent-tinted
// border/gradient shell lives in DashboardCard. Sourced from Claude Code's
// own undocumented usage/limits endpoint (see src/main/claudeUsage.ts) via
// `useClaudeUsage`. Renders:
//   - Session (five_hour) meter — "Session · 5h", utilization% + reset
//     countdown.
//   - Weekly (seven_day) meter — "Weekly · 7d", same shape.
//   - Model-scoped limit rows (limits[] where modelName != null) — small
//     "Fable 3%" rows, only rendered when present.
//   - Loading: skeleton bars. Unavailable: a calm inline message, never a
//     crash — the rest of the Dashboard is unaffected either way.
//
// THEME RULE: Orpheus tokens only. Meters use bg-surface-overlay track +
// accent fill; severity 'warning'/'elevated' recolors the fill to
// --color-severity-warning, 'critical' to --color-gh-closed (the same red
// token PrTable/checks already use for a failing state) — see
// severityFillClass below. tabular-nums on every %/count per the style rule.
// ---------------------------------------------------------------------------

import { cn } from '@/lib/utils'
import type { ClaudeUsageLimit, ClaudeUsageResult, ClaudeUsageWindow } from '@shared/types'
import { formatResetCountdown } from './dashboardHome.helpers'

/** Map an undocumented `severity` string to a meter-fill token class. Only
 *  'warning'/'elevated' and 'critical' are treated specially; any other/
 *  unknown value (including 'normal') falls back to the accent fill so a
 *  future severity string the endpoint adds doesn't silently render red. */
function severityFillClass(severity: string): string {
  const s = severity.toLowerCase()
  if (s === 'critical' || s === 'severe' || s === 'exceeded') {
    return 'bg-[color:var(--color-gh-closed)]'
  }
  if (s === 'warning' || s === 'elevated' || s === 'high') {
    return 'bg-[color:var(--color-severity-warning)]'
  }
  return 'bg-accent'
}

/** Meters additionally self-escalate purely from utilization% (independent
 *  of the endpoint's own `severity` string, which the two window fields
 *  don't carry) — a pragmatic >=90% -> critical / >=70% -> warning band so
 *  Session/Weekly still recolor sensibly even though five_hour/seven_day
 *  have no severity field of their own (only entries in `limits[]` do). */
function fillClassForUtilization(pct: number): string {
  if (pct >= 90) return 'bg-[color:var(--color-gh-closed)]'
  if (pct >= 70) return 'bg-[color:var(--color-severity-warning)]'
  return 'bg-accent'
}

function Meter({ label, window }: { label: string; window: ClaudeUsageWindow }): React.JSX.Element {
  const pct = window.utilization ?? 0
  const clamped = Math.min(100, Math.max(0, pct))
  const fillClass = fillClassForUtilization(clamped)

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] text-text-secondary">{label}</span>
        <span className="font-mono text-[11px] text-text-muted tabular-nums">
          {window.utilization === null ? '—' : `${Math.round(pct)}%`}
          {window.resetsAt ? (
            <span className="ml-1.5 text-text-muted/70">
              resets in {formatResetCountdown(window.resetsAt)}
            </span>
          ) : null}
        </span>
      </div>
      <div className="h-[7px] w-full overflow-hidden rounded-full bg-surface-overlay">
        <div
          className={cn('h-full rounded-full transition-[width]', fillClass)}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  )
}

function ModelLimitRow({ limit }: { limit: ClaudeUsageLimit }): React.JSX.Element {
  const fillClass = severityFillClass(limit.severity)
  return (
    <div className="flex items-center gap-2 text-[10.5px]">
      <span className="min-w-0 flex-1 truncate text-text-muted">{limit.modelName}</span>
      <div className="h-[4px] w-14 shrink-0 overflow-hidden rounded-full bg-surface-overlay">
        <div
          className={cn('h-full rounded-full', fillClass)}
          style={{ width: `${Math.min(100, Math.max(0, limit.percent))}%` }}
        />
      </div>
      <span className="w-8 shrink-0 text-right font-mono text-text-muted tabular-nums">
        {Math.round(limit.percent)}%
      </span>
      {limit.resetsAt ? (
        <span className="w-14 shrink-0 text-right font-mono text-[9.5px] text-text-muted/70 tabular-nums">
          {formatResetCountdown(limit.resetsAt)}
        </span>
      ) : null}
    </div>
  )
}

function LoadingSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col justify-center gap-3.5 py-1">
      {[0, 1].map((i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <div className="h-2.5 w-24 animate-pulse rounded bg-surface-overlay" />
          <div className="h-[6px] w-full animate-pulse rounded-full bg-surface-overlay" />
        </div>
      ))}
    </div>
  )
}

function UnavailableMessage({ reason }: { reason: 'no-auth' | 'error' }): React.JSX.Element {
  const message =
    reason === 'no-auth' ? 'Usage unavailable — sign in to Claude Code' : "Couldn't load usage"
  return (
    <div className="flex flex-1 items-center justify-center px-4 text-center text-[11.5px] text-text-muted">
      {message}
    </div>
  )
}

export function UsageLimitsCard({
  result,
  loading
}: {
  result: ClaudeUsageResult | null
  loading: boolean
}): React.JSX.Element {
  if (loading || result === null) {
    return <LoadingSkeleton />
  }

  if ('unavailable' in result) {
    return <UnavailableMessage reason={result.unavailable} />
  }

  // Model-scoped limits — only rows carrying a modelName (per the endpoint's
  // shape, session/weekly_all entries are unscoped and already rendered as
  // the two meters above via fiveHour/sevenDay, not via limits[]).
  const modelLimits = result.limits.filter((l) => l.modelName !== null)

  return (
    <div className="flex flex-1 flex-col justify-center gap-3.5 py-1">
      <Meter label="Session · 5h" window={result.fiveHour} />
      <Meter label="Weekly · 7d" window={result.sevenDay} />

      {modelLimits.length > 0 ? (
        <div className="mt-1 flex flex-col gap-1.5 border-t border-border-default pt-3">
          {modelLimits.map((limit, i) => (
            // kind+group+modelName is unique per response; index guards the
            // (extremely unlikely) duplicate-scope case without crashing.
            <ModelLimitRow
              key={`${limit.kind}-${limit.group}-${limit.modelName}-${i}`}
              limit={limit}
            />
          ))}
        </div>
      ) : null}

      {/* extra_usage / spend: only rendered when actually enabled on the
          account (per the task brief, this account has both disabled — the
          card renders nothing extra here, matching the graceful "no empty
          space, no dead rows" requirement). */}
      {result.extraUsageEnabled ? (
        <div className="border-t border-border-default pt-2.5 text-[10.5px] text-text-muted">
          Extra usage enabled
        </div>
      ) : null}
    </div>
  )
}
