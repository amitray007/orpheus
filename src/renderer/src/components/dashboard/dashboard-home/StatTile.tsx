// ---------------------------------------------------------------------------
// StatTile — one of the 4 "Your pulse" stat tiles (Sessions / Tokens /
// Current streak / Peak hour). Matches the mockup's `.stile`: small muted
// label on top, a large tabular-nums value below with an optional small
// trailing unit. Sample data for this unit — U3 wires real numbers.
// ---------------------------------------------------------------------------

export function StatTile({
  label,
  value,
  unit
}: {
  label: string
  value: string
  unit?: string
}): React.JSX.Element {
  return (
    <div className="rounded-[10px] border border-border-default bg-surface-raised px-3.5 py-3">
      <div className="mb-1 text-[11px] text-text-muted">{label}</div>
      <div className="flex items-baseline gap-1 font-mono text-xl font-semibold tracking-tight text-text-primary tabular-nums">
        {value}
        {unit ? <small className="text-sm font-medium text-text-secondary">{unit}</small> : null}
      </div>
    </div>
  )
}
