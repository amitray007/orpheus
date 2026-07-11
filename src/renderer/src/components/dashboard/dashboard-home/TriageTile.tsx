// ---------------------------------------------------------------------------
// TriageTile — one of the "Needs you now" tiles (Agents waiting / Open PRs /
// Open issues / Finished runs). Matches the mockup's `.tt`: a big count with
// a small colored status dot, a muted label (with an optional sublabel, e.g.
// "· 1 draft"), and a hover-revealed "jump ->" affordance. Click handlers are
// no-ops/TODO for this shell unit — U4/U5 wire real navigation.
// ---------------------------------------------------------------------------

import { cn } from '@/lib/utils'

export function TriageTile({
  count,
  dotClassName,
  label,
  sublabel,
  actionLabel,
  hot = false,
  onClick
}: {
  count: number
  dotClassName: string
  label: string
  sublabel?: string
  actionLabel: string
  hot?: boolean
  onClick?: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex cursor-pointer flex-col gap-0.5 rounded-[11px] border bg-surface-raised px-3.5 py-3 text-left transition-colors hover:bg-surface-overlay',
        hot ? 'border-accent/55' : 'border-border-default'
      )}
    >
      <div className="flex items-center gap-1.5 font-mono text-2xl font-semibold tracking-tight text-text-primary tabular-nums">
        <span className={cn('h-[9px] w-[9px] rounded-full', dotClassName)} aria-hidden="true" />
        {count}
      </div>
      <div className="text-[11px] text-text-muted">
        {label}
        {sublabel ? <span className="text-text-muted/70"> {sublabel}</span> : null}
      </div>
      <div className="mt-0.5 font-mono text-[9.5px] text-accent opacity-0 transition-opacity group-hover:opacity-100">
        {actionLabel} &rarr;
      </div>
    </button>
  )
}
