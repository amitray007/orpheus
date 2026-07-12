// ---------------------------------------------------------------------------
// DashboardSkeletons — V2 per-component skeleton system. Small, reusable,
// content-shaped placeholders shown ONLY on a genuine first-empty-load
// (loading && no cached rows yet — see D2's stale-while-revalidate hooks,
// which already keep `loading` false once ANY cached data exists). Never
// shown on a silent background refresh.
//
// Sibling to the existing settings-only Skeleton.tsx (SettingsSectionSkeleton)
// rather than folded into it — that file is settings-surface-specific; this
// one is dashboard-home-specific and shares this directory's other
// components. Both reuse the same `animate-pulse rounded bg-surface-overlay`
// idiom and Orpheus tokens (theme-aware, no hex).
// ---------------------------------------------------------------------------

import { cn } from '@/lib/utils'

const PULSE_BAR = 'animate-pulse rounded bg-surface-overlay'

/**
 * N shimmer rows shaped like a dashboard table row (two-line: a wider title
 * bar + a narrower meta bar underneath), sized to roughly match the fixed
 * column widths PrTable/IssuesTable/LiveAgentsTable already use. `cols`
 * controls how many extra trailing meta bars render (e.g. LiveAgentsTable's
 * State/Model/Since columns) — defaults to the common Pr/Issues shape
 * (just # + title, no extra trailing columns beyond the two-line stack).
 */
export function TableRowsSkeleton({
  rows,
  cols = 0
}: {
  /** Row count — pass the table's page size (or a smaller fixed count) so
   *  the skeleton isn't a huge block. */
  rows: number
  /** Extra trailing column bars per row (beyond the two-line title/meta
   *  stack), e.g. LiveAgentsTable's Project/Model/Since. */
  cols?: number
}): React.JSX.Element {
  return (
    <div className="flex flex-col">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 border-b border-border-default px-2.5 py-2 last:border-b-0"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className={cn(PULSE_BAR, 'h-2.5 w-[70%]')} />
            <div className={cn(PULSE_BAR, 'h-2 w-[40%]')} />
          </div>
          {Array.from({ length: cols }).map((__, c) => (
            <div key={c} className={cn(PULSE_BAR, 'h-2.5 w-12 shrink-0')} />
          ))}
          <div className={cn(PULSE_BAR, 'h-2.5 w-8 shrink-0')} />
        </div>
      ))}
    </div>
  )
}

/** Hero stat placeholder — a short number bar over a tiny label bar,
 *  matching StatTile's value/label stack shape. StatTile already renders
 *  its own inline `loading` bar for the value; this is the shared shape for
 *  any OTHER spot that wants the same stat-shaped skeleton (kept here so a
 *  future stat surface doesn't reinvent it). */
export function StatSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div className={cn(PULSE_BAR, 'h-[21px] w-12')} />
      <div className={cn(PULSE_BAR, 'h-2 w-16')} />
    </div>
  )
}
