// ---------------------------------------------------------------------------
// DashboardCard — the shared card shell used by every Dashboard section card
// (Activity, Models, Live agents, Open PRs, Issues). Matches the mockup's
// `.card`: tight padding, token border/surface, a title + small muted
// count/meta on the right. Hand-rolled rather than shadcn's <Card /> because
// the mockup's density (15px padding, 12.5px title) is tighter than shadcn's
// default card spacing — this keeps the page matching the design of record.
// ---------------------------------------------------------------------------

import { cn } from '@/lib/utils'

export function DashboardCard({
  title,
  meta,
  className,
  contentClassName,
  children
}: {
  title: string
  meta?: string
  className?: string
  contentClassName?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col gap-2.5 rounded-xl border border-border-default bg-surface-raised p-[15px]',
        className
      )}
    >
      <div className="flex items-center justify-between">
        <div className="text-[12.5px] font-semibold text-text-primary">{title}</div>
        {meta ? (
          <div className="font-mono text-[11px] text-text-muted tabular-nums">{meta}</div>
        ) : null}
      </div>
      <div className={cn('flex flex-1 flex-col', contentClassName)}>{children}</div>
    </div>
  )
}
