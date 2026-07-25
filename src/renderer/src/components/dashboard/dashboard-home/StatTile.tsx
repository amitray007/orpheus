// Compact stat display shared by Home pages.

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
  /** Renders the value in the muted `.v.dim` tone — for a stat whose value
   *  is a placeholder rather than real data. */
  dim?: boolean
  loading?: boolean
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={loading ? `${label}: loading` : `${label}: ${value}${unit ? ` ${unit}` : ''}`}
      className="flex flex-col items-center gap-px text-center whitespace-nowrap"
    >
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
