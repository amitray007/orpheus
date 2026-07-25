import type React from 'react'
import { memo } from 'react'

// ---------------------------------------------------------------------------
// Shared sidebar section primitives
// ---------------------------------------------------------------------------

interface SectionHeaderProps {
  label: string
  action?: React.ReactNode
}

export const SectionHeader = memo(function SectionHeader({
  label,
  action
}: SectionHeaderProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between px-3 mb-1 h-8">
      <p className="text-xs font-medium uppercase tracking-wider text-text-muted">{label}</p>
      {action}
    </div>
  )
})
