import { cn } from '@/lib/utils'
import type { WeeklyActivityDay } from './pulseData.helpers'
import { formatCompact } from './dashboardHome.helpers'

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const TRACK_WIDTH = 700
const TRACK_HEIGHT = 52
const TRACK_TOP = 3
const TRACK_BOTTOM = 49

interface ChartPoint {
  x: number
  y: number
  value: number
  dayIndex: number
}

function todayWeekdayMonFirst(): number {
  return (new Date().getDay() + 6) % 7
}

function normalizedValues(days: WeeklyActivityDay[], field: 'sessions' | 'messages'): number[] {
  const values = Array<number>(7).fill(0)
  for (const day of days) {
    if (day.weekday >= 0 && day.weekday < 7) values[day.weekday] = day[field]
  }
  return values
}

function trackPoints(values: number[], max: number): ChartPoint[] {
  const usableHeight = TRACK_BOTTOM - TRACK_TOP
  return values.map((value, dayIndex) => ({
    x: (dayIndex + 0.5) * (TRACK_WIDTH / 7),
    y: TRACK_BOTTOM - (value / max) * usableHeight,
    value,
    dayIndex
  }))
}

function metricSummary({
  colorClassName,
  label,
  total,
  max
}: {
  colorClassName: string
  label: string
  total: number
  max: number
}): React.JSX.Element {
  return (
    <div className="flex h-5 items-center justify-between gap-3 font-mono text-[10px]">
      <span className="inline-flex min-w-0 items-center gap-1.5 text-text-secondary">
        <span
          className={cn('h-1.5 w-1.5 shrink-0 rounded-full', colorClassName)}
          aria-hidden="true"
        />
        <span className="truncate">{label}</span>
        <span className="font-semibold text-text-primary tabular-nums">{formatCompact(total)}</span>
      </span>
      <span className="shrink-0 text-[9px] text-text-muted tabular-nums">
        Scale 0–{formatCompact(max)} / Day
      </span>
    </div>
  )
}

function SessionsTrack({ values, max }: { values: number[]; max: number }): React.JSX.Element {
  return (
    <div className="grid h-[52px] grid-cols-7 gap-2" role="list" aria-label="Sessions by weekday">
      {values.map((value, dayIndex) => {
        const heightPercent = value === 0 ? 4 : Math.max(10, (value / max) * 100)
        const exactLabel = `${WEEKDAY_NAMES[dayIndex]}: ${value} ${value === 1 ? 'session' : 'sessions'}`
        return (
          <div
            key={WEEKDAY_NAMES[dayIndex]}
            role="listitem"
            aria-label={exactLabel}
            title={exactLabel}
            tabIndex={0}
            className="flex h-full items-end justify-center border-b border-border-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/50"
          >
            <span
              className={cn(
                'block w-[58%] max-w-9 rounded-t-[3px]',
                value === 0 ? 'bg-surface-overlay' : 'bg-accent'
              )}
              style={{ height: `${heightPercent}%` }}
              aria-hidden="true"
            />
          </div>
        )
      })}
    </div>
  )
}

function TranscriptEventsTrack({
  values,
  max
}: {
  values: number[]
  max: number
}): React.JSX.Element {
  const points = trackPoints(values, max)
  const polyline = points.map(({ x, y }) => `${x},${y}`).join(' ')
  const areaPath = [
    `M ${points[0].x} ${TRACK_BOTTOM}`,
    ...points.map(({ x, y }) => `L ${x} ${y}`),
    `L ${points.at(-1)?.x ?? TRACK_WIDTH} ${TRACK_BOTTOM}`,
    'Z'
  ].join(' ')

  return (
    <div className="relative h-[52px] border-b border-border-default">
      <svg
        className="absolute inset-0 block h-full w-full overflow-visible"
        viewBox={`0 0 ${TRACK_WIDTH} ${TRACK_HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {points.map(({ x, dayIndex }) => (
          <line
            key={`guide-${dayIndex}`}
            x1={x}
            y1={TRACK_TOP}
            x2={x}
            y2={TRACK_BOTTOM}
            className="stroke-border-default"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
            opacity="0.45"
          />
        ))}
        <path d={areaPath} className="fill-[color:var(--color-chart-2)]" opacity="0.1" />
        <polyline
          points={polyline}
          fill="none"
          className="stroke-[color:var(--color-chart-2)]"
          strokeWidth="1.75"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {points.map(({ x, y, dayIndex }) => (
          <circle
            key={WEEKDAY_NAMES[dayIndex]}
            cx={x}
            cy={y}
            r="2.6"
            className="fill-[color:var(--color-chart-2)] stroke-surface-raised"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div
        className="absolute inset-0 grid grid-cols-7 gap-2"
        role="list"
        aria-label="Transcript events by weekday"
      >
        {points.map(({ value, dayIndex }) => {
          const exactLabel = `${WEEKDAY_NAMES[dayIndex]}: ${value} transcript ${
            value === 1 ? 'event' : 'events'
          }`
          return (
            <div
              key={WEEKDAY_NAMES[dayIndex]}
              role="listitem"
              aria-label={exactLabel}
              title={exactLabel}
              tabIndex={0}
              className="h-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/50"
            />
          )
        })}
      </div>
    </div>
  )
}

function WeekdayAxis({ todayIndex }: { todayIndex: number | null }): React.JSX.Element {
  return (
    <div className="grid h-4 grid-cols-7 gap-2 pt-1" aria-hidden="true">
      {WEEKDAY_LABELS.map((label, dayIndex) => (
        <span
          key={`${label}-${dayIndex}`}
          className={cn(
            'text-center font-mono text-[9px]',
            dayIndex === todayIndex ? 'font-semibold text-text-primary' : 'text-text-muted'
          )}
        >
          {label}
        </span>
      ))}
    </div>
  )
}

function LoadingSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col" aria-label="Preparing Claude activity" aria-busy="true">
      <div className="grid h-10 grid-cols-2 gap-4 border-b border-border-default pb-2">
        {[0, 1].map((item) => (
          <div key={item} className="flex min-w-0 flex-col justify-center gap-1">
            <div className="h-2 w-16 animate-pulse rounded bg-surface-overlay" />
            <div className="h-3 w-24 animate-pulse rounded bg-surface-overlay" />
          </div>
        ))}
      </div>

      {[0, 1].map((track) => (
        <div key={track} className="mt-2">
          <div className="flex h-5 items-center justify-between">
            <div className="h-2.5 w-24 animate-pulse rounded bg-surface-overlay" />
            <div className="h-2 w-20 animate-pulse rounded bg-surface-overlay" />
          </div>
          <div className="grid h-[52px] grid-cols-7 items-end gap-2 border-b border-border-default">
            {Array.from({ length: 7 }).map((_, dayIndex) => (
              <div
                key={dayIndex}
                className="mx-auto w-[58%] max-w-9 animate-pulse rounded-t-[3px] bg-surface-overlay"
                style={{ height: `${22 + ((dayIndex * 17 + track * 11) % 66)}%` }}
              />
            ))}
          </div>
        </div>
      ))}

      <div className="grid h-4 grid-cols-7 gap-2 pt-1">
        {Array.from({ length: 7 }).map((_, dayIndex) => (
          <div
            key={dayIndex}
            className="mx-auto h-2 w-2 animate-pulse rounded-sm bg-surface-overlay"
          />
        ))}
      </div>
    </div>
  )
}

export function ActivityChart({
  days,
  loading,
  highlightToday = true
}: {
  days: WeeklyActivityDay[]
  loading: boolean
  expanded?: boolean
  highlightToday?: boolean
}): React.JSX.Element {
  if (loading) return <LoadingSkeleton />

  const sessionsValues = normalizedValues(days, 'sessions')
  const messagesValues = normalizedValues(days, 'messages')
  const sessionsTotal = sessionsValues.reduce((sum, value) => sum + value, 0)
  const messagesTotal = messagesValues.reduce((sum, value) => sum + value, 0)
  const sessionsPeak = Math.max(0, ...sessionsValues)
  const messagesPeak = Math.max(0, ...messagesValues)
  const sessionsMax = Math.max(1, sessionsPeak)
  const messagesMax = Math.max(1, messagesPeak)
  const busiestDayIndex =
    sessionsTotal + messagesTotal === 0
      ? null
      : messagesValues.reduce(
          (busiest, value, dayIndex) =>
            value > messagesValues[busiest] ||
            (value === messagesValues[busiest] &&
              sessionsValues[dayIndex] > sessionsValues[busiest])
              ? dayIndex
              : busiest,
          0
        )
  const averageEvents = sessionsTotal === 0 ? null : Math.round(messagesTotal / sessionsTotal)
  const todayIndex = highlightToday ? todayWeekdayMonFirst() : null

  return (
    <div
      className="flex flex-1 flex-col"
      role="group"
      aria-label={`Claude activity: ${sessionsTotal} sessions and ${messagesTotal} transcript events for the selected week`}
    >
      <div className="grid h-10 grid-cols-2 gap-4 border-b border-border-default pb-2">
        <div className="flex min-w-0 flex-col justify-center">
          <span className="font-mono text-[9px] tracking-wide text-text-muted uppercase">
            Busiest Day
          </span>
          <span className="truncate text-[11px] font-medium text-text-primary">
            {busiestDayIndex === null ? 'No Activity This Week' : WEEKDAY_NAMES[busiestDayIndex]}
          </span>
        </div>
        <div className="flex min-w-0 flex-col justify-center border-l border-border-default pl-4">
          <span className="font-mono text-[9px] tracking-wide text-text-muted uppercase">
            Events / Session
          </span>
          <span className="font-mono text-[11px] font-semibold text-text-primary tabular-nums">
            {averageEvents === null ? '—' : formatCompact(averageEvents)}
          </span>
        </div>
      </div>

      <div className="mt-2">
        {metricSummary({
          colorClassName: 'bg-accent',
          label: 'Sessions',
          total: sessionsTotal,
          max: sessionsPeak
        })}
        <SessionsTrack values={sessionsValues} max={sessionsMax} />
      </div>

      <div className="mt-2">
        {metricSummary({
          colorClassName: 'bg-[color:var(--color-chart-2)]',
          label: 'Transcript Events',
          total: messagesTotal,
          max: messagesPeak
        })}
        <TranscriptEventsTrack values={messagesValues} max={messagesMax} />
      </div>

      <WeekdayAxis todayIndex={todayIndex} />
    </div>
  )
}
