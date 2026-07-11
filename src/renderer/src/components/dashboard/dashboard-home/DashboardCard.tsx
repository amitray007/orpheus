// ---------------------------------------------------------------------------
// DashboardCard — the shared card shell used by every Dashboard section card
// (Usage, Activity, Live agents, Open PRs, Issues). Matches the v3 mockup's
// `.panel`: tight padding, token border/surface, a title + small muted
// count/meta on the right, SHARP corners (`rounded-none`) — the hybrid-
// corner rule is that only TriageTile stays rounded, every other container
// (this one included) is sharp. Hand-rolled rather than shadcn's <Card />
// because the mockup's density (15px padding, 12.5px title) is tighter than
// shadcn's default card spacing.
//
// `variant="primary"` is the focal treatment for the ONE emphasized panel
// per row (currently Usage): an accent-tinted border plus a faint top-down
// accent gradient, both built from `color-mix(... var(--color-accent) ...)`
// so they stay theme-aware — matches the mockup's `.panel.primary`.
// ---------------------------------------------------------------------------

import { cn } from '@/lib/utils'

const PRIMARY_STYLE: React.CSSProperties = {
  borderColor: 'color-mix(in oklch, var(--color-accent) 30%, var(--color-border-default))',
  backgroundImage:
    'linear-gradient(180deg, color-mix(in oklch, var(--color-accent) 5%, var(--color-surface-raised)), var(--color-surface-raised))'
}

export function DashboardCard({
  title,
  meta,
  variant = 'default',
  className,
  contentClassName,
  children
}: {
  /** ReactNode (not just string) so a card can pair its title with an inline
   *  icon (e.g. GithubLogo on Open PRs / Issues assigned) — see PrTable /
   *  IssuesTable. Plain string usages keep working unchanged. */
  title: React.ReactNode
  meta?: string
  /** 'primary' = the focal/emphasized panel in a row (accent-tinted border +
   *  gradient); 'default' = the normal flat panel. */
  variant?: 'default' | 'primary'
  className?: string
  contentClassName?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col gap-2.5 rounded-none border border-border-default bg-surface-raised p-[15px]',
        className
      )}
      style={variant === 'primary' ? PRIMARY_STYLE : undefined}
    >
      <div className="flex items-baseline justify-between">
        <div className="text-[12.5px] font-semibold text-text-primary">{title}</div>
        {meta ? (
          <div className="font-mono text-[11px] text-text-muted tabular-nums">{meta}</div>
        ) : null}
      </div>
      <div className={cn('flex flex-1 flex-col', contentClassName)}>{children}</div>
    </div>
  )
}
