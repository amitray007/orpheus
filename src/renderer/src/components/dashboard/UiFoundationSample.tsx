// ---------------------------------------------------------------------------
// UiFoundationSample — THROWAWAY verification component for the U1 UI
// foundation unit (shadcn/ui + evilcharts + TanStack Table wiring). Proves
// that shadcn primitives + an evilcharts donut render themed in Orpheus's
// accent/surface colors, not generic shadcn slate/blue.
//
// Temporarily mounted in DashboardPlaceholder (MainContent.tsx) so it's
// reachable on the 🏠 Dashboard rail item in a dev build. U2 (Dashboard
// shell) replaces this with the real page — safe to delete this file then.
// ---------------------------------------------------------------------------

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  EvilPieChart,
  Pie,
  Legend as PieLegend,
  Tooltip as PieTooltip
} from '@/components/evilcharts/charts/pie-chart'
import type { ChartConfig } from '@/components/evilcharts/ui/chart'

const modelData = [
  { model: 'opus', sessions: 18 },
  { model: 'sonnet', sessions: 47 },
  { model: 'haiku', sessions: 9 }
]

// Single-color-per-sector config. "light" is the only theme key populated —
// Orpheus doesn't use a `.dark` class (it flips tokens via [data-theme]
// instead), so evilcharts' `.dark` variant selector never matches here; the
// `light` colors are var(--color-accent...) refs that already re-resolve
// per Orpheus theme, so this one config covers Midnight/Daylight/Eclipse.
const modelChartConfig = {
  opus: { label: 'Opus', colors: { light: ['var(--color-accent)'] } },
  sonnet: { label: 'Sonnet', colors: { light: ['var(--color-accent-hover)'] } },
  haiku: { label: 'Haiku', colors: { light: ['var(--color-text-muted)'] } }
} satisfies ChartConfig

export function UiFoundationSample(): React.JSX.Element {
  return (
    <div className="h-full overflow-auto p-6">
      <Card className="mx-auto max-w-md">
        <CardHeader>
          <CardTitle>UI foundation sample</CardTitle>
          <CardDescription>shadcn/ui + evilcharts, themed to Orpheus tokens</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Badge>Badge</Badge>
          </div>

          <Tabs defaultValue="donut">
            <TabsList>
              <TabsTrigger value="donut">Models</TabsTrigger>
              <TabsTrigger value="about">About</TabsTrigger>
            </TabsList>
            <TabsContent value="donut" className="h-56">
              <EvilPieChart
                config={modelChartConfig}
                data={modelData}
                dataKey="sessions"
                nameKey="model"
                className="h-full w-full p-4"
              >
                <PieLegend isClickable />
                <PieTooltip />
                <Pie isClickable innerRadius={40} />
              </EvilPieChart>
            </TabsContent>
            <TabsContent value="about" className="text-sm text-muted-foreground">
              This card proves the U1 foundation: shadcn primitives (Button, Badge, Tabs, Card) and
              an evilcharts donut, both themed via the shadcn-var → Orpheus-token mapping in
              main.css.
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}
