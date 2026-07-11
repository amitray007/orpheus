// ---------------------------------------------------------------------------
// DashboardTopBar — the greeting + range segmented control at the top of the
// Dashboard page. The greeting is time-of-day ONLY (no date, no counts, no
// live badge, per spec) computed from the current hour. The range control
// (All / 30d / 7d) is local, interactive state — it doesn't filter any data
// yet (U3/U4 wire that); it just needs to look and feel right.
// ---------------------------------------------------------------------------

import { cn } from '@/lib/utils'
import { greetingForHour, type DashboardRange } from './dashboardHome.helpers'

const RANGE_OPTIONS: { value: DashboardRange; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: '30d', label: '30d' },
  { value: '7d', label: '7d' }
]

export function DashboardTopBar({
  range,
  onRangeChange
}: {
  range: DashboardRange
  onRangeChange: (range: DashboardRange) => void
}): React.JSX.Element {
  const greeting = greetingForHour(new Date().getHours())

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="text-[15px] font-semibold tracking-tight text-text-primary">{greeting}</div>
      <div className="flex gap-0.5 rounded-lg bg-surface-overlay p-[3px]">
        {RANGE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onRangeChange(opt.value)}
            aria-pressed={range === opt.value}
            className={cn(
              'cursor-pointer rounded-md px-2.5 py-1 font-mono text-[11px] text-text-muted transition-colors',
              range === opt.value
                ? 'bg-surface-base text-text-primary'
                : 'hover:text-text-secondary'
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}
