// ---------------------------------------------------------------------------
// src/renderer/src/lib/useWorkspaceProviderIcon.ts
//
// Resolves the providerId a workspace's sidebar row should show its
// ProviderIcon prefix for. Composes two already-existing, already-cached
// data sources — never a new model->provider matcher:
//   1. workspaceModelStore (this workspace's effective model id, fetched
//      once via workspace:getEffectiveModel — the SAME IPC call the footer
//      Model chip already uses, see DropdownChip.tsx).
//   2. useSelectableModels (the shared, cached selectable-model list — the
//      SAME list every other picker renders from) to look up that model
//      id's `providerId`/`isClaude`, exactly like DropdownChip's own
//      `currentModelIsClaude` lookup does for the footer chip.
// ---------------------------------------------------------------------------

import { useEffect } from 'react'
import { useSelectableModels } from './useSelectableModels'
import {
  getCachedWorkspaceModel,
  setWorkspaceModel,
  useWorkspaceModel
} from './workspaceModelStore'

// One in-flight fetch per workspace id so a row that re-renders before the
// first fetch resolves doesn't issue a second workspace:getEffectiveModel
// call for the same workspace.
const inFlight = new Set<string>()

function fetchEffectiveModel(workspaceId: string): void {
  if (inFlight.has(workspaceId)) return
  if (getCachedWorkspaceModel(workspaceId) !== undefined) return
  inFlight.add(workspaceId)
  window.api.workspaces
    .getEffectiveModel(workspaceId)
    .then((r) => setWorkspaceModel(workspaceId, r.model))
    .catch(() => {
      // Leave uncached on failure — ProviderIcon renders nothing rather than
      // a wrong guess; a later render (e.g. after the workspace mounts) will
      // retry since the cache is still empty.
    })
    .finally(() => {
      inFlight.delete(workspaceId)
    })
}

/** Returns the providerId to render a ProviderIcon for, or null while
 *  unresolved (never fetched yet, fetch in flight, or fetch failed) — the
 *  caller should render nothing (not a placeholder) for null. */
export function useWorkspaceProviderIcon(workspaceId: string): string | null {
  const modelId = useWorkspaceModel(workspaceId)

  useEffect(() => {
    fetchEffectiveModel(workspaceId)
  }, [workspaceId])

  // Deliberately called with NO currentModelId (cache key '') so every
  // sidebar row shares ONE models:listSelectable fetch, instead of each
  // row's own model id minting a separate cache entry/IPC round trip (which
  // is fine for a single footer chip — DropdownChip's own usage — but would
  // fan out badly across N sidebar rows on N different models). The shared
  // list covers every currently AVAILABLE model; a workspace pinned to a
  // routed model whose provider is now disconnected simply renders no icon
  // (graceful degradation, not a second bespoke fetch).
  const { models } = useSelectableModels(undefined, true)

  if (!modelId) return null
  const match = models.find((m) => m.id === modelId)
  return match?.providerId ?? null
}
