// ---------------------------------------------------------------------------
// ActivityChart — the "Activity" pulse card's content, REPLACING the 6-month
// heatmap (formerly ActivityHeatmap.tsx). Per activity-chart.html "OPTION B,
// small multiples": two side-by-side Mon-Sun mini bar charts — Sessions
// (gold) and Messages (chart-2/cool) — each SELF-SCALED to its own week max.
// This is deliberate, not an oversight: sessions (a handful/week) and
// messages (hundreds/week) live on wildly different scales, so a single
// shared axis (or a dual-axis overlay) would flatten sessions to nothing
// next to messages — "never two y-scales on one chart" per the mockup's own
// note. Small multiples sidesteps that by giving each metric its own axis
// and just aligning the two charts on the weekday axis so their SHAPES can
// still be eyeballed side by side.
//
// Zero-value days render a faint stub bar (bg-surface-overlay, ~4% height)
// so the weekday axis still reads even on a quiet day, rather than the bar
// vanishing entirely. Today's weekday label is emphasized (text-text-primary
// + semibold) against the otherwise-muted M T W T F S S row.
// ---------------------------------------------------------------------------

import { cn } from '@/lib/utils'
import type { WeeklyActivityDay } from './pulseData.helpers'
import { formatCompact } from './dashboardHome.helpers'

const WEEKDAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

// Today's weekday, Mon=0..Sun=6 — matches computeWeeklyActivity's ordering.
function todayWeekdayMonFirst(): number {
  return (new Date().getDay() + 6) % 7
}

function MiniBarChart({
  values,
  barClassName,
  todayIndex
}: {
  values: number[]
  barClassName: string
  todayIndex: number
}): React.JSX.Element {
  const max = Math.max(1, ...values)
  return (
    <div className="flex h-[78px] items-end gap-[5px]">
      {values.map((v, i) => {
        const isZero = v === 0
        const heightPct = isZero ? 4 : Math.max(8, (v / max) * 100)
        return (
          <div key={i} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
            <div
              title={`${v}`}
              className={cn('w-full rounded-t-[3px]', isZero ? 'bg-surface-overlay' : barClassName)}
              style={{ height: `${heightPct}%` }}
            />
            <span
              className={cn(
                'font-mono text-[10px]',
                i === todayIndex ? 'font-semibold text-text-primary' : 'text-text-muted'
              )}
            >
              {WEEKDAY_LABELS[i]}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function LoadingSkeleton(): React.JSX.Element {
  return (
    <div className="grid flex-1 grid-cols-2 gap-5">
      {[0, 1].map((i) => (
        <div key={i} className="flex flex-col gap-2.5">
          <div className="h-3 w-16 animate-pulse rounded bg-surface-overlay" />
          <div className="flex h-[78px] items-end gap-[5px]">
            {Array.from({ length: 7 }).map((_, day) => (
              <div
                key={day}
                className="flex-1 animate-pulse rounded-t-[3px] bg-surface-overlay"
                style={{ height: `${30 + ((day * 13) % 50)}%` }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function ActivityChart({
  days,
  loading
}: {
  days: WeeklyActivityDay[]
  loading: boolean
}): React.JSX.Element {
  if (loading || days.length === 0) {
    return <LoadingSkeleton />
  }

  const sessionsValues = days.map((d) => d.sessions)
  const messagesValues = days.map((d) => d.messages)
  const sessionsTotal = sessionsValues.reduce((sum, v) => sum + v, 0)
  const messagesTotal = messagesValues.reduce((sum, v) => sum + v, 0)
  const todayIndex = todayWeekdayMonFirst()

  return (
    <div className="grid flex-1 grid-cols-2 gap-5">
      <div>
        <div className="mb-2.5 flex items-baseline justify-between font-mono text-[11px] text-text-secondary">
          <span>Sessions</span>
          <span className="text-[13px] font-semibold text-text-primary tabular-nums">
            {formatCompact(sessionsTotal)}
          </span>
        </div>
        <MiniBarChart values={sessionsValues} barClassName="bg-accent" todayIndex={todayIndex} />
      </div>
      <div>
        <div className="mb-2.5 flex items-baseline justify-between font-mono text-[11px] text-text-secondary">
          <span>Messages</span>
          <span className="text-[13px] font-semibold text-text-primary tabular-nums">
            {formatCompact(messagesTotal)}
          </span>
        </div>
        <MiniBarChart
          values={messagesValues}
          barClassName="bg-[color:var(--color-chart-2)]"
          todayIndex={todayIndex}
        />
      </div>
    </div>
  )
}
