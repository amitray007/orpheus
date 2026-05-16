import type React from 'react'

interface SkeletonProps {
  className?: string
  style?: React.CSSProperties
}

/**
 * Single shimmer block. Pulse animates between surface-raised → surface-overlay.
 * Compose multiples to build skeleton layouts.
 */
export function Skeleton({ className = '', style }: SkeletonProps): React.JSX.Element {
  return (
    <div
      className={['rounded animate-pulse bg-surface-overlay', className].join(' ')}
      style={style}
      role="status"
      aria-label="Loading"
    />
  )
}

/** Three placeholder project rows for the sidebar loading state. */
export function ProjectListSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 px-1 mt-1">
      <Skeleton className="h-8 w-full opacity-70" />
      <Skeleton className="h-8 w-5/6 opacity-50" />
      <Skeleton className="h-8 w-4/6 opacity-30" />
    </div>
  )
}

/** Three placeholder session rows for the main content loading state. */
export function SessionListSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {[70, 90, 60].map((w, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2">
          <Skeleton className="w-2 h-2 rounded-full flex-shrink-0" />
          <Skeleton className={`h-4 flex-1`} style={{ maxWidth: `${w}%` }} />
          <Skeleton className="h-3 w-16 flex-shrink-0" />
        </div>
      ))}
    </div>
  )
}

/**
 * Skeleton shaped like a settings section body: one or more card groups,
 * each with a small header label and a few labeled rows with a control on
 * the right. The eventual content is a stack of `<section>` blocks each
 * holding a `bg-surface-raised border` card of `SettingRow`s — this skeleton
 * matches that layout so the section title above it doesn't shift when the
 * real data arrives.
 */
export function SettingsSectionSkeleton({
  groups = 2,
  rowsPerGroup = 2
}: {
  groups?: number
  rowsPerGroup?: number
} = {}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-8">
      {Array.from({ length: groups }).map((_, gi) => (
        <section key={gi} className="flex flex-col">
          <Skeleton className="h-3 w-24 mb-3 opacity-60" />
          <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-1 divide-y divide-border-default/40">
            {Array.from({ length: rowsPerGroup }).map((_, ri) => (
              <div key={ri} className="flex items-center justify-between py-4 gap-4">
                <div className="flex flex-col gap-2 min-w-0 flex-1">
                  <Skeleton className="h-3.5 w-40 max-w-full" />
                  <Skeleton className="h-3 w-64 max-w-full opacity-60" />
                </div>
                <Skeleton className="h-7 w-28 flex-shrink-0" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

/** Skeleton for a list of commit cards (matches CommitsTab's card layout). */
export function CommitListSkeleton({ count = 5 }: { count?: number } = {}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="rounded-lg border border-border-default bg-surface-raised px-4 py-3"
        >
          <Skeleton className="h-3.5 w-3/4 mb-2" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-3 w-16 opacity-60" />
            <Skeleton className="h-3 w-24 opacity-60" />
            <Skeleton className="h-3 w-12 opacity-60" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** Skeleton row block used inside the WorkspaceDrawer overrides section. */
export function WorkspaceOverridesSkeleton(): React.JSX.Element {
  return (
    <div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="px-4 py-3 border-t border-border-default/30 first:border-t-0">
          <Skeleton className="h-3 w-20 mb-2 opacity-60" />
          <Skeleton className="h-7 w-full opacity-70" />
        </div>
      ))}
    </div>
  )
}
