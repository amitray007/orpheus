// ---------------------------------------------------------------------------
// src/renderer/src/components/dashboard/WorkspaceProviderIcon.tsx
//
// Sidebar workspace row's provider-icon prefix slot (before the status dot —
// see Sidebar.tsx's WorkspaceStatusIcon). Renders nothing (not a
// placeholder) until the workspace's effective model has resolved to a
// known provider — see useWorkspaceProviderIcon's own doc comment for why
// (never a fabricated guess, matches every other "unknown -> render
// nothing" convention in this codebase, e.g. ActivityIndicator).
// ---------------------------------------------------------------------------

import type React from 'react'
import { ProviderIcon } from '../ProviderIcon'
import { useWorkspaceProviderIcon } from '@/lib/useWorkspaceProviderIcon'

export function WorkspaceProviderIcon({
  workspaceId
}: {
  workspaceId: string
}): React.JSX.Element | null {
  const providerId = useWorkspaceProviderIcon(workspaceId)
  if (!providerId) return null
  return <ProviderIcon providerId={providerId} size={11} />
}
