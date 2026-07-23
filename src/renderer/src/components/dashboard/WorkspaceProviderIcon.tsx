// ---------------------------------------------------------------------------
// src/renderer/src/components/dashboard/WorkspaceProviderIcon.tsx
//
// Sidebar workspace row's provider-icon slot (trailing edge, immediately
// left of the time/archive slot — see Sidebar.tsx). Renders nothing (not a
// placeholder) until the workspace's effective model has resolved to a
// known provider — see useWorkspaceProviderIcon's own doc comment for why
// (never a fabricated guess, matches every other "unknown -> render
// nothing" convention in this codebase, e.g. ActivityIndicator).
// ---------------------------------------------------------------------------

import type React from 'react'
import { ProviderIcon } from '../ProviderIcon'
import { useWorkspaceProviderIcon } from '@/lib/useWorkspaceProviderIcon'

export function WorkspaceProviderIcon({
  workspaceId,
  size = 14
}: {
  workspaceId: string
  /** Pixel size of the icon. Defaults to 14 (the row's original leading-slot
   *  size); the trailing-slot call site passes 12 to sit comfortably beside
   *  11px time text. */
  size?: number
}): React.JSX.Element | null {
  const providerId = useWorkspaceProviderIcon(workspaceId)
  if (!providerId) return null
  return <ProviderIcon providerId={providerId} size={size} />
}
