// ---------------------------------------------------------------------------
// ActivityHeatmap — the REAL GitHub-style session activity heatmap (U3),
// replacing ActivityHeatmapPlaceholder. Hand-rolled CSS grid (7 rows x ~26
// cols, grid-auto-flow: column, most recent week on the right) per spec —
// no chart lib. Cells are colored by intensity level (0-4) using a gold
// sequential ramp built from the Orpheus accent token via `color-mix`, so it
// stays theme-aware (Midnight/Daylight/Eclipse) without any hardcoded hex:
// level 1..4 = accent at 22% / 44% / 68% / 100% mixed over the card surface.
// ---------------------------------------------------------------------------

import { useMemo } from 'react'
import { WEEKDAY_NAMES, busiestWeekday, type HeatmapCell } from './pulseData.helpers'

// Sequential ramp: color-mix(accent, surface-raised) at increasing accent
// share. Level 0 (no activity) stays a flat muted surface tone, not part of
// the ramp, so "no data" reads as distinct from "a little data".
const LEVEL_BACKGROUND: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: 'var(--color-surface-overlay)',
  1: 'color-mix(in oklab, var(--color-accent) 22%, var(--color-surface-raised))',
  2: 'color-mix(in oklab, var(--color-accent) 44%, var(--color-surface-raised))',
  3: 'color-mix(in oklab, var(--color-accent) 68%, var(--color-surface-raised))',
  4: 'var(--color-accent)'
}

function formatCellTitle(cell: HeatmapCell): string {
  const label = cell.count === 1 ? 'session' : 'sessions'
  return `${cell.count} ${label} on ${cell.date}`
}

export function ActivityHeatmap({
  cells,
  loading
}: {
  cells: HeatmapCell[]
  loading: boolean
}): React.JSX.Element {
  const weeks = cells.length > 0 ? cells.length / 7 : 26

  const busiestLabel = useMemo(() => {
    if (loading || cells.length === 0) return null
    const dow = busiestWeekday(cells)
    return dow === null ? null : `Busiest on ${WEEKDAY_NAMES[dow]}`
  }, [cells, loading])

  return (
    <div className="flex flex-1 flex-col gap-2">
      <div
        className="grid flex-1 gap-[3px]"
        style={{
          gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(7, minmax(0, 1fr))`,
          gridAutoFlow: 'column'
        }}
      >
        {loading
          ? // Skeleton: muted cells, no data yet, so we never flash zeros.
            Array.from({ length: weeks * 7 }).map((_, i) => (
              <div
                key={i}
                className="aspect-square animate-pulse rounded-[2.5px] bg-surface-overlay"
              />
            ))
          : cells.map((cell) => (
              <div
                key={cell.date}
                title={formatCellTitle(cell)}
                className="aspect-square rounded-[2.5px]"
                style={{ background: LEVEL_BACKGROUND[cell.level] }}
              />
            ))}
      </div>
      <div className="flex items-center justify-between font-mono text-[10px] text-text-muted">
        <span>{loading ? '' : (busiestLabel ?? 'No activity yet')}</span>
        <span className="flex items-center gap-1">
          less
          <span
            className="h-2.5 w-2.5 rounded-[2.5px]"
            style={{ background: LEVEL_BACKGROUND[0] }}
          />
          <span
            className="h-2.5 w-2.5 rounded-[2.5px]"
            style={{ background: LEVEL_BACKGROUND[1] }}
          />
          <span
            className="h-2.5 w-2.5 rounded-[2.5px]"
            style={{ background: LEVEL_BACKGROUND[2] }}
          />
          <span
            className="h-2.5 w-2.5 rounded-[2.5px]"
            style={{ background: LEVEL_BACKGROUND[3] }}
          />
          <span
            className="h-2.5 w-2.5 rounded-[2.5px]"
            style={{ background: LEVEL_BACKGROUND[4] }}
          />
          more
        </span>
      </div>
    </div>
  )
}
