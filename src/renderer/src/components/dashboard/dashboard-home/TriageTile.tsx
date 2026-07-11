// ---------------------------------------------------------------------------
// TriageTile — one of the "Needs you now" chips (Agents waiting / Open PRs /
// Open issues / Finished runs). V1 REBUILD: replaces the old big vertical
// tile (count-on-top, big padded card) with the mockup's compact horizontal
// `.tchip`: a colored status dot, a big-but-small number, then a label
// (+ optional sublabel, e.g. "· 1 draft") stacked beside it — flex-wrap row,
// `flex:1; min-width:150px` per chip. HYBRID CORNERS (explicit, deliberate
// design decision): TriageTile is the ONLY rounded element on the entire
// dashboard — every other panel/card/table on the page is sharp
// (rounded-none). Do not "fix" this to match the rest of the page. `hot`
// still tints the border toward accent (an agent waiting on you is the most
// actionable state). The mockup's compact chip has no room for a
// hover-revealed "jump ->" affordance like the old tile did, so
// `actionLabel` is surfaced as an aria-label instead of visible copy — kept
// in the prop signature so callers (and screen readers) still get it.
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
      aria-label={`${label}: ${count}. ${actionLabel}.`}
      className={cn(
        'flex min-w-[150px] flex-1 cursor-pointer items-center gap-2.5 rounded-xl border bg-surface-raised px-3.5 py-2.5 text-left transition-colors hover:bg-surface-overlay',
        hot ? 'border-accent/55' : 'border-border-default'
      )}
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dotClassName)} aria-hidden="true" />
      <span className="font-mono text-xl leading-none font-semibold tracking-tight text-text-primary tabular-nums">
        {count}
      </span>
      <span className="flex min-w-0 flex-col gap-px">
        <span className="truncate text-xs text-text-secondary">{label}</span>
        {sublabel ? (
          <span className="truncate font-mono text-[10px] text-text-muted/70">{sublabel}</span>
        ) : null}
      </span>
    </button>
  )
}
