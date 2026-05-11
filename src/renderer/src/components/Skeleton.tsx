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
