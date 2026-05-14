import type React from 'react'
import type { WorkspaceStatus } from '@shared/types'
import { Spinner } from '../Spinner'

interface ActivityIndicatorProps {
  status: WorkspaceStatus | undefined
  className?: string
}

export function ActivityIndicator({
  status,
  className
}: ActivityIndicatorProps): React.JSX.Element | null {
  if (!status || status === 'idle' || status === 'archived') return null

  const base = 'inline-flex items-center justify-center flex-shrink-0 leading-none w-3'
  const cls = className ? `${base} ${className}` : base

  if (status === 'in_progress') {
    return (
      <span className={`${cls} text-accent`}>
        <Spinner size="sm" />
      </span>
    )
  }
  if (status === 'awaiting_input') {
    return <span className={`${cls} text-emerald-400 text-xs font-mono`}>●</span>
  }
  if (status === 'attention') {
    return <span className={`${cls} text-amber-400 text-xs font-mono animate-pulse`}>●</span>
  }
  return null
}
