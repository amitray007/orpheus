// ---------------------------------------------------------------------------
// src/renderer/src/lib/modelEffortPickerState.ts
//
// Footer-removal migration, Phase 1 — the shared READ-SIDE state every
// model/effort picker needs, extracted out of components/dashboard/footer/
// DropdownChip.tsx so the title bar's new chips (WorkspaceTitleBar.tsx) can
// assemble the SAME facts (current model, current effort, the selectable
// model list, the current model's real effort levels, the harness's
// harness-level effort fallback) instead of re-deriving the ~8-hook chain
// DropdownChip.tsx builds before its dispatcher block. Read that file's
// Case 1/Case 2 sections (roughly lines 240-402) in full before touching
// this — every value this hook returns is a direct port of a value
// DropdownChip.tsx already computes the same way; nothing here is a new
// derivation.
//
// WHY A HOOK, NOT A PURE FUNCTION — unlike modelEffortSelection.ts (this
// directory), this module genuinely needs React's hook machinery: it reads
// from per-workspace external stores (workspaceModelStore/
// workspaceEffortStore) via useSyncExternalStore-backed hooks, and fires a
// one-shot fetch-on-mount effect to seed those stores on first paint. That
// is real subscription/effect behavior, not something a plain function
// could express — it can only be asserted through the DOM-touching harness
// tests this repo doesn't run for React components, so this module's
// counterpart pure-logic verifier (verify-model-effort-selection.ts) covers
// modelEffortSelection.ts instead, exactly as CLAUDE.md's discipline
// expects: extract the PURE decision separately so it stays independently
// testable, and accept the hook-shaped state assembly as verified by
// reading the diff + the existing DropdownChip.tsx behavior staying
// byte-identical (test:agentic's full suite is the regression net for
// that).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { HarnessId } from '@shared/harness/types'
import type { HarnessSummary } from '@shared/types'
import { resolveEffortLevelsForScope } from './effortPickerOptions'
import { useSelectableModels, refetchSelectableModels } from './useSelectableModels'
import { setWorkspaceModel, useWorkspaceModel } from './workspaceModelStore'
import { setWorkspaceEffort, useWorkspaceEffort } from './workspaceEffortStore'
import { isModelEffectivelyClaude } from '@shared/harness/footerChipGating'

export interface ModelEffortPickerState {
  /** Effective model id, '' when unset — from the SHARED per-workspace
   *  store (see workspaceModelStore.ts's own doc comment on why: multiple
   *  chip instances for the same workspace must all read/react to the
   *  SAME value). */
  modelValue: string
  /** Effective effort value, '' when unset — same shared-store rationale as
   *  modelValue, via workspaceEffortStore.ts. */
  effortValue: string
  /** The data-driven selectable model list for this harness/project scope
   *  (useSelectableModels) — Claude always present, routed/harness models
   *  gated server-side. */
  selectableModels: ReturnType<typeof useSelectableModels>['models']
  /** Whether selectableModels is still loading — needed by
   *  resolveEffortLevelsForScope to distinguish "no levels" from "not
   *  resolved yet" (see that function's own tri-state doc comment). */
  selectableModelsLoading: boolean
  /** Whether the CURRENT modelValue resolves as Claude for live-apply
   *  gating purposes — see isModelEffectivelyClaude's own doc comment. */
  currentModelIsClaude: boolean
  /** The current model's real effort levels — see
   *  resolveEffortLevelsForScope's tri-state doc comment
   *  (effortPickerOptions.ts) for the full null/undefined/string[]
   *  contract this carries. */
  currentModelEffortLevels: string[] | null | undefined
  /** The harness's OWN flat effort option list (harness.curated?.effort?.options)
   *  — the fallback source for a harness whose models never carry per-model
   *  effortLevels (see harness.curated?.effort's own doc comment at the
   *  DropdownChip.tsx call site this was lifted from). */
  harnessEffortOptions: string[] | undefined
  /** Imperative refetch, to call when a picker is about to open (defense-in-
   *  depth against a missed push — mirrors DropdownChip.tsx's handleClick
   *  refetch-on-open behavior). Refetches the selectable-model list AND the
   *  effective model/effort in one call. */
  refetchAll: () => void
}

/**
 * Assembles the shared read-side state for a model/effort picker instance.
 * `enabled` (default true) mirrors useSelectableModels' own `enabled` param
 * — a caller that only ever shows a read-only display (no picker at all)
 * can pass false to skip the fetch/subscription entirely while still
 * calling every hook unconditionally (Rules of Hooks) and getting back the
 * synchronous Claude-only fallback shape.
 */
export function useModelEffortPickerState(
  workspaceId: string,
  harness: HarnessSummary,
  harnessId: HarnessId | undefined,
  projectId: string | undefined,
  enabled = true
): ModelEffortPickerState {
  const storeModelValue = useWorkspaceModel(workspaceId)
  const modelValue = storeModelValue ?? ''
  // Refs so the imperative refetchAll callback below always reads the
  // CURRENT value rather than whatever was current when refetchAll was
  // last (re)created — same staleness-avoidance pattern DropdownChip.tsx's
  // modelValueRef/effortValueRef use, for the identical reason (a narrowly-
  // memoized callback would otherwise pin these to a stale snapshot).
  const modelValueRef = useRef(modelValue)
  // eslint-disable-next-line react-hooks/refs -- intentional render-time ref mutation, same pattern as DropdownChip.tsx's modelValueRef
  modelValueRef.current = modelValue

  const storeEffortValue = useWorkspaceEffort(workspaceId)
  const effortValue = storeEffortValue ?? ''
  const effortValueRef = useRef(effortValue)
  // eslint-disable-next-line react-hooks/refs -- intentional render-time ref mutation, same pattern as DropdownChip.tsx's effortValueRef
  effortValueRef.current = effortValue

  const refetchEffectiveModel = useCallback((): void => {
    if (!enabled) return
    window.api.workspaces
      .getEffectiveModel(workspaceId)
      .then((r) => setWorkspaceModel(workspaceId, r.model))
      .catch(() => {})
  }, [workspaceId, enabled])
  useEffect(() => {
    refetchEffectiveModel()
  }, [refetchEffectiveModel])

  const refetchEffectiveEffort = useCallback((): void => {
    if (!enabled) return
    window.api.workspaces
      .getEffectiveEffort(workspaceId)
      .then((r) => setWorkspaceEffort(workspaceId, r.effort))
      .catch(() => {})
  }, [workspaceId, enabled])
  useEffect(() => {
    refetchEffectiveEffort()
  }, [refetchEffectiveEffort])

  const { models: selectableModels, loading: selectableModelsLoading } = useSelectableModels(
    enabled ? modelValue : undefined,
    enabled,
    harnessId,
    projectId,
    enabled ? effortValue : undefined
  )

  const currentModelIsClaude = useMemo(
    () => isModelEffectivelyClaude(harness.id, selectableModels, modelValue),
    [harness.id, selectableModels, modelValue]
  )

  const currentModelEffortLevels = useMemo(
    () =>
      resolveEffortLevelsForScope(
        modelValue,
        selectableModels,
        selectableModelsLoading,
        harness.id === 'claude'
      ),
    [selectableModels, selectableModelsLoading, modelValue, harness.id]
  )

  const harnessEffortOptions = harness.curated?.effort?.options

  const refetchAll = useCallback((): void => {
    if (enabled) {
      refetchSelectableModels(modelValueRef.current, harnessId, projectId, effortValueRef.current)
    }
    refetchEffectiveModel()
    refetchEffectiveEffort()
  }, [enabled, harnessId, projectId, refetchEffectiveModel, refetchEffectiveEffort])

  return {
    modelValue,
    effortValue,
    selectableModels,
    selectableModelsLoading,
    currentModelIsClaude,
    currentModelEffortLevels,
    harnessEffortOptions,
    refetchAll
  }
}
