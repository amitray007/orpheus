// ---------------------------------------------------------------------------
// useSelectableModels — fetches the single selectable-model list (Claude +
// gated routed models) from models:listSelectable (model-routing unit 06).
//
// The renderer must never compute model facts or availability itself —
// gating (proxy running? provider connected/healthy?) happens entirely
// server-side in src/main/models/selectable.ts. This hook is the one place
// a picker component (WorkspaceDrawer/SettingsDrawer/DropdownChip) asks main
// for that list, refetching whenever `currentModelId` changes so an
// already-selected-but-now-unavailable model is always represented (see
// models:listSelectable's own doc comment for the "never lose the user's
// setting" contract).
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from 'react'
import type { SelectableModel } from '@shared/types'

export interface UseSelectableModelsResult {
  models: SelectableModel[]
  loading: boolean
}

/**
 * @param currentModelId the workspace/project's currently-selected model id
 *   (if any) — passed through so an unavailable-but-selected routed model is
 *   still included in the result, marked `available: false`, rather than
 *   silently dropped from the list.
 */
export function useSelectableModels(currentModelId?: string): UseSelectableModelsResult {
  const [models, setModels] = useState<SelectableModel[]>([])
  const [loading, setLoading] = useState(true)
  // Bumped once per effect run (not read reactively) so a stale in-flight
  // response from a superseded `currentModelId` never overwrites a newer
  // one. `setLoading(true)` is intentionally NOT called synchronously in the
  // effect body (that would cascade a render on every dependency change) —
  // loading only flips true->false->true across actual async completions.
  const requestIdRef = useRef(0)

  useEffect(() => {
    const requestId = ++requestIdRef.current
    let cancelled = false
    window.api.models
      .listSelectable(currentModelId)
      .then((list) => {
        if (!cancelled && requestId === requestIdRef.current) {
          setModels(list)
          setLoading(false)
        }
      })
      .catch((err) => {
        console.error('[useSelectableModels] listSelectable failed', err)
        if (!cancelled && requestId === requestIdRef.current) {
          setModels([])
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [currentModelId])

  return { models, loading }
}
