// ---------------------------------------------------------------------------
// StatTile — one of the 4 "Your pulse" stat tiles (Sessions / Tokens /
// Current streak / Peak hour). Matches the mockup's `.stile`: small muted
// label on top, a large tabular-nums value below with an optional small
// trailing unit. Real numbers wired in U3 (usePulseData); `loading` shows a
// muted skeleton bar instead of flashing a stale/zero value, and an optional
// `subLabel` renders a small muted line under the value (used by the Tokens
// tile's "soon" placeholder).
// ---------------------------------------------------------------------------

export function StatTile({
  label,
  value,
  unit,
  subLabel,
  loading
}: {
  label: string
  value: string
  unit?: string
  subLabel?: string
  loading?: boolean
}): React.JSX.Element {
  return (
    <div className="rounded-[10px] border border-border-default bg-surface-raised px-3.5 py-3">
      <div className="mb-1 text-[11px] text-text-muted">{label}</div>
      {loading ? (
        <div className="h-6 w-14 animate-pulse rounded bg-surface-overlay" />
      ) : (
        <div className="flex items-baseline gap-1 font-mono text-xl font-semibold tracking-tight text-text-primary tabular-nums">
          {value}
          {unit ? <small className="text-sm font-medium text-text-secondary">{unit}</small> : null}
        </div>
      )}
      {subLabel && !loading ? (
        <div className="mt-0.5 text-[10px] text-text-muted">{subLabel}</div>
      ) : null}
    </div>
  )
}
