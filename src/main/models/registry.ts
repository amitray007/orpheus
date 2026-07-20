// ---------------------------------------------------------------------------
// src/main/models/registry.ts — the ONE owner for "what do we know about
// model X?"
//
// This is a strangler-fig replacement for:
//   - three disagreeing label parsers (modelLabel / prettifyModelLabel /
//     shortModel)
//   - two disagreeing context-budget paths (getContextBudget vs
//     getEffectiveContextBudget / DEFAULT_CONTEXT_BUDGET)
//   - pricing.ts's family-alias substring matching, which could apply Claude
//     pricing to a third-party id that merely contains "opus"/"sonnet"/
//     "haiku"/"fable" or is spelled with a "claude-" prefix
//
// Precedence: sources are tried in array order and the FIRST source to
// resolve an id wins. builtinClaudeSource is always first — see
// sources/builtin.ts's isClaudeModelId for why that structurally prevents
// any other source from ever shadowing a Claude id.
// ---------------------------------------------------------------------------

import type { ModelInfo, ModelSource } from './types'
import { builtinClaudeSource, isClaudeModelId } from './sources/builtin'
import { modelsDevSource, refreshModelsDevCache } from './sources/modelsDev'

export type { ModelInfo, Pricing, ModelSource } from './types'
export { isClaudeModelId }
export { refreshModelsDevCache }

// Precedence order. A future CLIProxyAPI source (unit 05) slots in here,
// after modelsDevSource — the ModelSource interface is intentionally generic
// enough that adding one is just appending to this array. builtinClaudeSource
// must never move from index 0.
const SOURCES: ModelSource[] = [builtinClaudeSource, modelsDevSource]

/**
 * Resolve everything the app knows about a model id. Always returns a
 * ModelInfo — for a completely unrecognized id, `context`/`pricing` are
 * `null` and `family` is a best-effort guess (never fabricated numbers).
 *
 * Claude ids resolve fully with NO network access: builtinClaudeSource is
 * synchronous and offline, and — being first in SOURCES — is consulted
 * before any network-backed source even has a chance to run. If every
 * external source is unreachable, Claude models are completely unaffected;
 * only third-party ids degrade to "known id, unknown context/pricing".
 */
export function resolveModel(modelId: string): ModelInfo {
  for (const source of SOURCES) {
    const info = source.resolve(modelId)
    if (info) return info
  }

  // No source recognizes this id — return the explicit "unknown model"
  // shape. Never invent a context window or a price for it.
  return {
    id: modelId,
    label: modelId,
    family: null,
    isClaude: false,
    context: null,
    pricing: null,
    supportsReasoning: false
  }
}

/** Convenience: the one canonical label function. Replaces modelLabel,
 *  prettifyModelLabel, and shortModel. */
export function modelLabel(modelId: string | null | undefined): string {
  if (!modelId) return '—'
  return resolveModel(modelId).label
}

/** Convenience: is this id a Claude model, per the registry's own
 *  structural definition (never re-derive with string matching). */
export function isClaude(modelId: string): boolean {
  return resolveModel(modelId).isClaude
}

// ---------------------------------------------------------------------------
// Per-model context caps
//
// effectiveContext = min(reportedContext, userCapForModel ?? Infinity)
//
// `disable1mContext` (CLAUDE_CODE_DISABLE_1M_CONTEXT) is now ONE INSTANCE of
// this general mechanism rather than a Claude-only special case: it's a
// 200_000-token cap that applies only when the resolved model is Claude.
// Passing a `capTokens` (from claude_global_settings.maxContextTokens, or a
// future per-model override) applies uniformly to any model, Claude or not.
// ---------------------------------------------------------------------------

export type ContextCapOptions = {
  /** Claude's disable-1m-context toggle. Only takes effect when the
   *  resolved model isClaude — never leaks onto non-Claude models. */
  disable1mContext?: boolean
  /** A user-configured cap in tokens (e.g. claude_global_settings.
   *  maxContextTokens), applied regardless of model. */
  capTokens?: number | null
}

/**
 * Resolve a model's effective context window after applying caps. Returns
 * null when the model's native context is unknown — a cap can only shrink a
 * known number, never fabricate one where none exists.
 */
export function effectiveContext(modelId: string, options: ContextCapOptions = {}): number | null {
  const info = resolveModel(modelId)
  if (info.context === null) return null

  let budget = info.context

  if (options.disable1mContext && info.isClaude) {
    budget = Math.min(budget, 200_000)
  }

  if (options.capTokens != null && options.capTokens > 0) {
    budget = Math.min(budget, options.capTokens)
  }

  return budget
}

/**
 * Full resolution used by context-budget consumers: model info + effective
 * (capped) context in one call, so callers don't have to resolve twice.
 */
export function resolveContextBudget(
  modelId: string,
  options: ContextCapOptions = {}
): { modelId: string; info: ModelInfo; contextBudget: number | null } {
  return {
    modelId,
    info: resolveModel(modelId),
    contextBudget: effectiveContext(modelId, options)
  }
}
