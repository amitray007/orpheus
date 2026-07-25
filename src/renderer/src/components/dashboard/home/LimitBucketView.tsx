import { cn } from '@/lib/utils'
import { formatResetCountdown } from '../dashboard-home/dashboardHome.helpers'
import type { LimitBucket } from './home.types'

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function usagePercent(bucket: LimitBucket): number | null {
  if (bucket.used === undefined || bucket.total === undefined || bucket.total <= 0) return null
  return Math.min(100, Math.max(0, (bucket.used / bucket.total) * 100))
}

export function LimitBucketView({
  bucket,
  compact = false
}: {
  bucket: LimitBucket
  compact?: boolean
}): React.JSX.Element {
  const percent = usagePercent(bucket)
  const usageParts = [
    bucket.remaining === undefined ? null : `${formatValue(bucket.remaining)} remaining`,
    bucket.used === undefined ? null : `${formatValue(bucket.used)} used`,
    bucket.total === undefined ? null : `${formatValue(bucket.total)} total`
  ].filter((part): part is string => part !== null)

  return (
    <div className={cn('flex flex-col gap-1.5', compact && 'gap-1')}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="min-w-0 text-sm text-text-primary">{bucket.label}</span>
        {usageParts.length > 0 ? (
          <span className="font-mono text-xs text-text-muted tabular-nums">
            {usageParts.join(' · ')}
          </span>
        ) : null}
      </div>
      {percent !== null ? (
        <div
          className="h-[7px] w-full overflow-hidden rounded-full bg-surface-overlay"
          role="progressbar"
          aria-label={`${bucket.label} used`}
          aria-valuemin={0}
          aria-valuemax={bucket.total}
          aria-valuenow={bucket.used}
        >
          <div
            className="h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}
      {bucket.resetsAt !== undefined ? (
        <span className="font-mono text-xs text-text-muted/70 tabular-nums">
          Resets in {formatResetCountdown(new Date(bucket.resetsAt).toISOString())}
        </span>
      ) : null}
    </div>
  )
}
