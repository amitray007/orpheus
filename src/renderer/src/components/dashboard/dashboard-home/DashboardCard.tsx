// Shared card shell for Home page sections.

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
  /** A title may include an inline icon as well as text. */
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
