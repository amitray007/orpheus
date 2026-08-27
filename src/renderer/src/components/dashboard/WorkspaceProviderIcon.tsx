// ---------------------------------------------------------------------------
// src/renderer/src/components/dashboard/WorkspaceProviderIcon.tsx
//
// Sidebar workspace row's provider-icon slot (trailing edge, immediately
// left of the time/archive slot — see Sidebar.tsx). Two-tier resolution:
//
//   1. Model-derived provider (useWorkspaceProviderIcon) is AUTHORITATIVE
//      when it resolves to a known provider — a Claude workspace routed to
//      a known model must render EXACTLY as it always has; the fallback
//      below never runs for that case.
//   2. Harness-icon fallback (the `harnessIconFallback` prop) is used ONLY
//      when the model-derived provider is unavailable (null) — e.g. a Codex
//      workspace, whose effective model never resolves to an entry in the
//      selectable-model list (see useWorkspaceProviderIcon's own header for
//      why that list can't help a non-Claude harness). This is NOT a
//      "fabricated guess" in the sense useWorkspaceProviderIcon's header
//      comment warns against: a workspace's `harness_id` is authoritative,
//      DB-backed data (set at creation, unlike a model-routing inference),
//      so falling back to the harness's own icon is a narrower, still-honest
//      affordance sitting next to that existing convention, not a weakening
//      of it.
//
// Still renders nothing (not a placeholder) when NEITHER tier resolves —
// matches every other "unknown -> render nothing" convention in this
// codebase (e.g. ActivityIndicator).
// ---------------------------------------------------------------------------

import type React from 'react'
import { ProviderIcon } from '../ProviderIcon'
import { useWorkspaceProviderIcon } from '@/lib/useWorkspaceProviderIcon'

/**
 * Pure resolution: model-derived providerId wins when present; otherwise the
 * harness-icon fallback (if any); otherwise null (render nothing). Extracted
 * as a standalone function — rather than left inline as unreachable-from-a-
 * test JSX — so a verifier can import and call it directly with
 * representative inputs (see scripts/verify-workspace-provider-icon.ts).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function resolveWorkspaceProviderIconId(
  modelDerivedProviderId: string | null,
  harnessIconFallback: string | null | undefined
): string | null {
  if (modelDerivedProviderId) return modelDerivedProviderId
  return harnessIconFallback ?? null
}

export function WorkspaceProviderIcon({
  workspaceId,
  size = 14,
  harnessIconFallback
}: {
  workspaceId: string
  /** Pixel size of the icon. Defaults to 14 (the row's original leading-slot
   *  size); the trailing-slot call site passes 12 to sit comfortably beside
   *  11px time text. */
  size?: number
  /** This workspace's harness icon id (HarnessSummary.icon, e.g. 'codex'),
   *  used ONLY when the model-derived provider doesn't resolve. Pass the
   *  already-resolved `harness.icon` a caller has in scope (e.g. Sidebar.tsx's
   *  WorkspaceSubRow already calls useHarnessForWorkspace for other capability
   *  gating) — this component never fetches it itself, to avoid a second
   *  per-row data source on top of useWorkspaceProviderIcon's existing one. */
  harnessIconFallback?: string
}): React.JSX.Element | null {
  const modelDerivedProviderId = useWorkspaceProviderIcon(workspaceId)
  const providerId = resolveWorkspaceProviderIconId(modelDerivedProviderId, harnessIconFallback)
  if (!providerId) return null
  return <ProviderIcon providerId={providerId} size={size} />
}
