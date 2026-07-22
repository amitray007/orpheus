// ---------------------------------------------------------------------------
// useSelectableModels — the single hook every picker (WorkspaceDrawer/
// SettingsDrawer/DropdownChip) uses to read the selectable-model list
// (Claude + gated routed models). Thin wrapper over the shared
// useSyncExternalStore-backed cache in selectableModelsStore.ts, which owns:
//
//   - the synchronous, zero-IPC Claude fallback (first paint AND any IPC
//     failure — never `[]`, see claudeFallbackModels' own doc comment)
//   - request coalescing across concurrent callers for the same
//     currentModelId (so DropdownChip + WorkspaceDrawer + SettingsDrawer
//     mounted together still fire ONE models:listSelectable round-trip)
//   - cache invalidation on routingProxy:onSnapshot pushes, instead of
//     polling
//
// The renderer must never compute model facts itself — gating (proxy
// running? provider connected/healthy?) happens entirely server-side in
// src/main/models/selectable.ts. This hook only decides WHETHER to ask (via
// `enabled`), never WHAT the answer is.
//
// `enabled` (default true) lets a caller that renders a model picker only
// conditionally (e.g. DropdownChip, which also handles non-model dropdown
// actionIds) skip the fetch entirely for chips that never touch the model
// list — WITHOUT calling this hook conditionally, which would violate the
// Rules of Hooks. The hook itself is always called; only the internal
// subscription/IPC is gated by `enabled`.
// ---------------------------------------------------------------------------

import type { SelectableModel } from '@shared/types'
import { useSelectableModelsStore, refetchSelectableModels } from './selectableModelsStore'

// Re-exported so callers (DropdownChip's open handler) go through this
// module — the one every picker already imports — rather than reaching past
// it into selectableModelsStore.ts directly. See that function's own doc
// comment for what it's for (defense-in-depth: a fresh read the moment the
// picker actually opens, in case a routingProxy:onSnapshot push is ever
// missed).
export { refetchSelectableModels }

export interface UseSelectableModelsResult {
  models: SelectableModel[]
  loading: boolean
}

/**
 * @param currentModelId the workspace/project's currently-selected model id
 *   (if any) — passed through so an unavailable-but-selected routed model is
 *   still included in the result, marked `available: false`, rather than
 *   silently dropped from the list.
 * @param enabled when false, no IPC/subscription happens at all and the
 *   result is the synchronous Claude-only fallback — for callers that don't
 *   need the routed list this render (default true).
 */
export function useSelectableModels(
  currentModelId?: string,
  enabled = true
): UseSelectableModelsResult {
  return useSelectableModelsStore(currentModelId, enabled)
}
