import { LimitBucketView } from '../LimitBucketView'
import { HomePageFrame } from './HomePageFrame'
import type { HomePageProps, ProviderLimitSnapshot } from '../home.types'

function ProviderLimits({ provider }: { provider: ProviderLimitSnapshot }): React.JSX.Element {
  if (provider.availability === 'unavailable') {
    return (
      <p role="status" aria-live="polite" className="text-sm text-text-muted">
        Usage is unavailable for this provider.
      </p>
    )
  }
  if (provider.availability === 'error') {
    return (
      <p role="status" aria-live="polite" className="text-sm text-text-muted">
        Couldn&apos;t load usage for this provider.
      </p>
    )
  }
  if (provider.buckets.length === 0) {
    return (
      <p role="status" aria-live="polite" className="text-sm text-text-muted">
        No usage limits are available.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {provider.buckets.map((bucket) => (
        <LimitBucketView key={bucket.id} bucket={bucket} />
      ))}
    </div>
  )
}

export function LimitsPage({ snapshot }: HomePageProps): React.JSX.Element {
  const { limits } = snapshot
  const hasProviders = limits.data.length > 0

  return (
    <HomePageFrame title="Limits" source={limits} emptyCopy="No usage limits are available.">
      {limits.loading ? (
        <div className="h-24 animate-pulse rounded-lg bg-surface-overlay" />
      ) : limits.unavailable ? (
        <p role="status" aria-live="polite" className="text-sm text-text-muted">
          Usage limits are unavailable.
        </p>
      ) : limits.error ? (
        <p role="status" aria-live="polite" className="text-sm text-text-muted">
          {limits.error}
        </p>
      ) : !hasProviders ? (
        <p role="status" aria-live="polite" className="text-sm text-text-muted">
          No usage limits are available.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {limits.data.map((provider) => (
            <section
              key={provider.provider.id}
              className="rounded-lg border border-border-default bg-surface-raised p-5"
              aria-labelledby={`limits-provider-${provider.provider.id}`}
            >
              <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                <h2
                  id={`limits-provider-${provider.provider.id}`}
                  className="text-sm font-semibold text-text-primary"
                >
                  {provider.provider.label}
                </h2>
                {provider.stale ? (
                  <span role="status" aria-live="polite" className="text-xs text-text-muted">
                    Showing saved data
                  </span>
                ) : null}
              </div>
              <ProviderLimits provider={provider} />
            </section>
          ))}
        </div>
      )}
    </HomePageFrame>
  )
}
