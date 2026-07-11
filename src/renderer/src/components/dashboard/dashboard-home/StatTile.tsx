// ---------------------------------------------------------------------------
// StatTile — one of the hero row's inline stats (Sessions / Tokens / Current
// streak / Peak hour). V1 REBUILD: this used to be a bordered box
// (rounded-[10px] border + bg-surface-raised card); per dashboard-v3.html's
// `.hero .stats .stat`, it's now a BARE inline stack — no border, no
// background, no padding-box — value on top (`.v`: tabular-nums, ~21px,
// semibold) with an optional small trailing unit (`.v small`), a tiny muted
// key label below (`.k`). The critique that drove this rebuild flagged the
// old boxed tiles as "huge half-empty hero-metric cards"; the inline
// treatment sits directly in DashboardTopBar's hero row instead of its own
// card grid. `dim` renders the value in the muted `.v.dim` tone (used by the
// Tokens placeholder, whose value is "—" until a real cross-session token
// rollup exists — see DashboardView.tsx). `loading` shows a bare skeleton
// bar (no card wrapper to skeleton) instead of flashing a stale/zero value.
// ---------------------------------------------------------------------------

export function StatTile({
  label,
  value,
  unit,
  subLabel,
  dim,
  loading
}: {
  label: string
  value: string
  unit?: string
  subLabel?: string
  /** Renders the value in the muted `.v.dim` tone — used for placeholder
   *  values (e.g. Tokens' "—") that aren't real data yet. */
  dim?: boolean
  loading?: boolean
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-px whitespace-nowrap">
      {loading ? (
        <div className="h-[21px] w-12 animate-pulse rounded bg-surface-overlay" />
      ) : (
        <div
          className={`font-mono text-[21px] leading-[1.05] font-semibold tracking-tight tabular-nums ${
            dim ? 'text-text-muted' : 'text-text-primary'
          }`}
        >
          {value}
          {unit ? (
            <small className="ml-px text-xs font-medium text-text-secondary">{unit}</small>
          ) : null}
        </div>
      )}
      <div className="text-[10.5px] tracking-[0.02em] text-text-muted">
        {label}
        {subLabel && !loading ? <span className="text-text-muted/70"> · {subLabel}</span> : null}
      </div>
    </div>
  )
}
