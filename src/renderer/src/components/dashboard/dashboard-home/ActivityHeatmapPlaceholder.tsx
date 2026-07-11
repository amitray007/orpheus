// ---------------------------------------------------------------------------
// ActivityHeatmapPlaceholder — a stand-in for the GitHub-style session
// activity heatmap (~6 months, sessions/day). This unit builds page
// structure only; U3 replaces this with the real heatmap computed from
// `sessions:listAll`. Rendered as a plain CSS grid of empty token-colored
// cells so the card's shape/spacing is validated now.
// ---------------------------------------------------------------------------

const PLACEHOLDER_COLS = 26
const PLACEHOLDER_ROWS = 7
const PLACEHOLDER_CELLS = Array.from({ length: PLACEHOLDER_COLS * PLACEHOLDER_ROWS })

export function ActivityHeatmapPlaceholder(): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col gap-2">
      <div
        className="grid flex-1 gap-[3px]"
        style={{
          gridTemplateColumns: `repeat(${PLACEHOLDER_COLS}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${PLACEHOLDER_ROWS}, minmax(0, 1fr))`,
          gridAutoFlow: 'column'
        }}
      >
        {PLACEHOLDER_CELLS.map((_, i) => (
          <div key={i} className="aspect-square rounded-[2.5px] bg-surface-overlay" />
        ))}
      </div>
      <div className="flex items-center justify-between font-mono text-[10px] text-text-muted">
        <span>Busiest on Wednesdays</span>
        <span className="flex items-center gap-1">
          less
          <span className="h-2.5 w-2.5 rounded-[2.5px] bg-surface-overlay" />
          <span className="h-2.5 w-2.5 rounded-[2.5px] bg-accent/25" />
          <span className="h-2.5 w-2.5 rounded-[2.5px] bg-accent/50" />
          <span className="h-2.5 w-2.5 rounded-[2.5px] bg-accent/75" />
          <span className="h-2.5 w-2.5 rounded-[2.5px] bg-accent" />
          more
        </span>
      </div>
    </div>
  )
}
