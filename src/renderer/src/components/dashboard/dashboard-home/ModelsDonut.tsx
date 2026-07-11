// ---------------------------------------------------------------------------
// ModelsDonut — the "Models" pulse card: session count by model (Opus /
// Sonnet / Haiku) as a THICK donut (evilcharts Pie, U1) with a centered
// total, plus a legend. SAMPLE data for this shell unit — U3 wires the real
// per-model session breakdown. innerRadius/outerRadius are tuned to a ~40%
// band (chunky ring, matching the updated mockup's `.donut` mask treatment)
// rather than evilcharts' thin default. Colors come from Orpheus's chart
// tokens (--color-chart-1/2/3, themed from accent/accent-hover/text-muted)
// so the ring stays on-brand in both light and dark.
// ---------------------------------------------------------------------------

import { EvilPieChart, Pie, Tooltip as PieTooltip } from '@/components/evilcharts/charts/pie-chart'
import type { ChartConfig } from '@/components/evilcharts/ui/chart'

interface ModelSlice extends Record<string, unknown> {
  model: string
  sessions: number
}

const SAMPLE_MODEL_DATA: ModelSlice[] = [
  { model: 'opus', sessions: 284 },
  { model: 'sonnet', sessions: 100 },
  { model: 'haiku', sessions: 34 }
]

const SAMPLE_TOTAL = SAMPLE_MODEL_DATA.reduce((sum, d) => sum + d.sessions, 0)

// Single-color-per-sector config, same pattern as UiFoundationSample (U1):
// "light" colors resolve through Orpheus's --color-chart-* vars, which are
// themed per Midnight/Daylight/Eclipse — so one config covers every theme.
const MODEL_CHART_CONFIG = {
  opus: { label: 'Opus 4.8', colors: { light: ['var(--color-chart-1)'] } },
  sonnet: { label: 'Sonnet 5', colors: { light: ['var(--color-chart-2)'] } },
  haiku: { label: 'Haiku 4.5', colors: { light: ['var(--color-chart-3)'] } }
} satisfies ChartConfig

const LEGEND_SWATCH: Record<string, string> = {
  opus: 'var(--color-chart-1)',
  sonnet: 'var(--color-chart-2)',
  haiku: 'var(--color-chart-3)'
}

export function ModelsDonut(): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center gap-7 py-1.5">
      <div className="relative h-[150px] w-[150px] shrink-0">
        <EvilPieChart
          config={MODEL_CHART_CONFIG}
          data={SAMPLE_MODEL_DATA}
          dataKey="sessions"
          nameKey="model"
          className="h-full w-full"
        >
          <PieTooltip />
          {/* THICK ring: outerRadius ~78% of the container, innerRadius ~58% of
              the outer radius -> the band is ~40% of the radius, a chunky
              modern donut rather than evilcharts' thin default. */}
          <Pie innerRadius="58%" outerRadius="100%" paddingAngle={2} cornerRadius={3} />
        </EvilPieChart>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono text-[26px] font-bold tracking-tight text-text-primary tabular-nums">
            {SAMPLE_TOTAL}
          </span>
          <span className="mt-1 font-mono text-[10px] tracking-wide text-text-muted">sessions</span>
        </div>
      </div>
      <div className="flex max-w-[160px] flex-1 flex-col gap-2.5">
        {SAMPLE_MODEL_DATA.map((slice) => {
          const pct = Math.round((slice.sessions / SAMPLE_TOTAL) * 100)
          const label = MODEL_CHART_CONFIG[slice.model as keyof typeof MODEL_CHART_CONFIG].label
          return (
            <div key={slice.model} className="flex items-center gap-2.5 text-[12.5px]">
              <span
                className="h-[11px] w-[11px] shrink-0 rounded-[3px]"
                style={{ background: LEGEND_SWATCH[slice.model] }}
                aria-hidden="true"
              />
              <span className="flex-1 text-text-secondary">{label}</span>
              <span className="font-mono font-semibold text-text-primary tabular-nums">{pct}%</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
