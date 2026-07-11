// ---------------------------------------------------------------------------
// ModelsDonut — the "Models" pulse card: real session count by model (Opus /
// Sonnet / Haiku / Other), as a THICK donut (evilcharts Pie) with a centered
// total = the real session count, plus a legend with real names + %. Colors
// come from Orpheus's chart tokens (--color-chart-1/2/3/4, themed from
// accent/accent-hover/text-secondary/text-muted) so the ring stays on-brand
// in both light and dark. innerRadius/outerRadius stay tuned to a ~40% band
// (chunky ring) per spec.
// ---------------------------------------------------------------------------

import { useMemo } from 'react'
import { EvilPieChart, Pie, Tooltip as PieTooltip } from '@/components/evilcharts/charts/pie-chart'
import type { ChartConfig } from '@/components/evilcharts/ui/chart'
import type { ModelSliceData } from './pulseData.helpers'

interface ModelSlice extends Record<string, unknown> {
  slug: string
  label: string
  sessions: number
}

// Chart color tokens, in priority order — assigned to the top slices in the
// order they're returned (already sorted by count desc), so the biggest
// slice always gets the primary accent color regardless of which model it
// is. 4 tokens covers the max slice count (top-3 + "Other").
const CHART_COLOR_VARS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)'
]

/** CSS-var-safe slug for a model label (evilcharts interpolates this key
 *  straight into a `--color-<key>-0` CSS custom property name). */
function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

export function ModelsDonut({
  models,
  loading
}: {
  models: ModelSliceData[]
  loading: boolean
}): React.JSX.Element {
  const slices: ModelSlice[] = useMemo(
    () => models.map((m) => ({ slug: slugify(m.key), label: m.label, sessions: m.count })),
    [models]
  )

  const total = slices.reduce((sum, d) => sum + d.sessions, 0)

  const chartConfig = useMemo(() => {
    const config: ChartConfig = {}
    slices.forEach((slice, i) => {
      config[slice.slug] = {
        label: slice.label,
        colors: { light: [CHART_COLOR_VARS[i % CHART_COLOR_VARS.length]] }
      }
    })
    return config
  }, [slices])

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-7 py-1.5">
        <div className="h-[150px] w-[150px] shrink-0 animate-pulse rounded-full bg-surface-overlay" />
        <div className="flex max-w-[160px] flex-1 flex-col gap-2.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-3 w-full animate-pulse rounded bg-surface-overlay" />
          ))}
        </div>
      </div>
    )
  }

  if (total === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-[12.5px] text-text-muted">
        No sessions yet
      </div>
    )
  }

  return (
    <div className="flex flex-1 items-center justify-center gap-7 py-1.5">
      <div className="relative h-[150px] w-[150px] shrink-0">
        <EvilPieChart
          config={chartConfig}
          data={slices}
          dataKey="sessions"
          nameKey="slug"
          className="h-full w-full"
        >
          <PieTooltip />
          {/* THICK ring: outerRadius ~100% of the container, innerRadius ~58%
              -> a chunky modern donut rather than evilcharts' thin default. */}
          <Pie innerRadius="58%" outerRadius="100%" paddingAngle={2} cornerRadius={3} />
        </EvilPieChart>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono text-[26px] font-bold tracking-tight text-text-primary tabular-nums">
            {total}
          </span>
          <span className="mt-1 font-mono text-[10px] tracking-wide text-text-muted">sessions</span>
        </div>
      </div>
      <div className="flex max-w-[160px] flex-1 flex-col gap-2.5">
        {slices.map((slice, i) => {
          const pct = Math.round((slice.sessions / total) * 100)
          return (
            <div key={slice.slug} className="flex items-center gap-2.5 text-[12.5px]">
              <span
                className="h-[11px] w-[11px] shrink-0 rounded-[3px]"
                style={{ background: CHART_COLOR_VARS[i % CHART_COLOR_VARS.length] }}
                aria-hidden="true"
              />
              <span className="flex-1 text-text-secondary">{slice.label}</span>
              <span className="font-mono font-semibold text-text-primary tabular-nums">{pct}%</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
