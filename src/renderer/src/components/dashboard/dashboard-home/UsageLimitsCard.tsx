import { LimitBucketView } from '../home/LimitBucketView'
import { normalizeUsage } from '../home/homeFacade'
import type { ClaudeUsageResult } from '@shared/types'

function LoadingSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col justify-center gap-3.5 py-1">
      {[0, 1].map((index) => (
        <div key={index} className="flex flex-col gap-1.5">
          <div className="h-2.5 w-24 animate-pulse rounded bg-surface-overlay" />
          <div className="h-[6px] w-full animate-pulse rounded-full bg-surface-overlay" />
        </div>
      ))}
    </div>
  )
}

function UnavailableMessage({ reason }: { reason: 'no-auth' | 'error' }): React.JSX.Element {
  const message =
    reason === 'no-auth' ? 'Usage unavailable — sign in to Claude Code' : "Couldn't load usage"
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-1 items-center justify-center px-4 text-center text-[11.5px] text-text-muted"
    >
      {message}
    </div>
  )
}

export function UsageLimitsCard({
  result,
  loading
}: {
  result: ClaudeUsageResult | null
  loading: boolean
}): React.JSX.Element {
  if (loading || result === null) return <LoadingSkeleton />
  if ('unavailable' in result) return <UnavailableMessage reason={result.unavailable} />

  const provider = normalizeUsage(result, 0, false)[0]
  if (!provider || provider.buckets.length === 0) {
    return (
      <p role="status" aria-live="polite" className="text-[11.5px] text-text-muted">
        No usage limits are available.
      </p>
    )
  }

  return (
    <div className="flex flex-1 flex-col justify-center gap-3.5 py-1">
      {provider.buckets.map((bucket) => (
        <LimitBucketView key={bucket.id} bucket={bucket} compact />
      ))}
    </div>
  )
}
