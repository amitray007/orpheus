// ---------------------------------------------------------------------------
// src/shared/harness/actionTypeGating.ts
//
// Single source of truth for "does this footer action_id make sense for a
// given harness" — the SAME decision src/main/footerActions.ts's
// FOOTER_ACTION_GATES table makes at list time, now also consumable by the
// renderer's FooterActionEditor so the AUTHORING UI stops offering action
// types that main will silently filter back out.
//
// THE BUG THIS FIXES: main already refuses to render a `footer.modelSelect`
// / `footer.effortSelect` / `session.getUsage` / `session.getCost` /
// `workspace.fork` chip when the workspace's resolved harness lacks the
// capability/curated field the action needs (FOOTER_ACTION_GATES in
// src/main/footerActions.ts). But FooterActionEditor.tsx offered every
// ActionType unconditionally — a user could author, say, a Model chip,
// save it, and it would never appear on a harness with no curated.model,
// with zero explanation. Editor and list-time filter must agree; a
// divergence between them IS the bug, so both consumers call this one
// function rather than each re-encoding the rule.
//
// SHAPE, NOT IDENTITY: this takes a minimal structural type (capabilities +
// curated) rather than the full HarnessDescriptor/HarnessSummary, so both
// main's HarnessDescriptor (src/main/harness/registry.ts, via
// src/shared/harness/types.ts) and the renderer's HarnessSummary
// (src/shared/types.ts) satisfy it with no adapter/mapping layer — see
// HarnessSummary's own doc comment: it is deliberately a projection of
// HarnessDescriptor carrying exactly `capabilities` and `curated` among the
// fields this function needs.
//
// ONE ANSWER PER (actionId, harness) PAIR — same as FOOTER_ACTION_GATES: an
// actionId absent from ACTION_TYPE_GATES is always applicable (matches
// main's "gate ? gate(harness) : true" fallthrough for action ids that need
// no capability from any harness, e.g. workspace.archive/rename). This
// module intentionally mirrors ONLY the four action ids that are actually
// harness-gated in main; terminal.sendInput's per-ROW provenance gate
// (sendInputPassesHarnessGate) is a different kind of check — it depends on
// the STORED ROW's stamped harnessId, not on any predicate over the target
// harness's capabilities, so it has no analogue here and is out of scope
// for "which action TYPES can a user pick in the editor."
// ---------------------------------------------------------------------------

import type { HarnessCapabilities, CuratedField } from './types'

// The minimal shape both HarnessDescriptor (main) and HarnessSummary
// (renderer) satisfy — see this file's header for why a structural type is
// used instead of importing either concrete type.
export interface ActionGateHarness {
  capabilities: HarnessCapabilities
  curated?: { model?: CuratedField; effort?: CuratedField }
}

type ActionGatePredicate = (harness: ActionGateHarness) => boolean

// DATA, not if/else — mirrors FOOTER_ACTION_GATES in
// src/main/footerActions.ts exactly. Keep the two in lockstep: this table
// IS the implementation FOOTER_ACTION_GATES now delegates to (see that
// file), so there is only one place to edit when a gate's rule changes.
export const ACTION_TYPE_GATES: Record<string, ActionGatePredicate> = {
  'workspace.fork': (h) => h.capabilities.fork,
  'session.getUsage': (h) => h.capabilities.usage,
  'session.getCost': (h) => h.capabilities.usage,
  'footer.modelSelect': (h) => h.curated?.model !== undefined,
  'footer.effortSelect': (h) => h.curated?.effort !== undefined
}

/**
 * Whether `actionId` is applicable for `harness` — true for any actionId
 * not present in ACTION_TYPE_GATES (no capability required from any
 * harness), otherwise the table's predicate result.
 */
export function isActionTypeApplicable(actionId: string, harness: ActionGateHarness): boolean {
  const gate = ACTION_TYPE_GATES[actionId]
  return gate ? gate(harness) : true
}

/**
 * A short, user-facing reason a gated action type is inapplicable to a
 * SPECIFIC harness — only meaningful when isActionTypeApplicable(actionId,
 * harness) is false; callers should not display this otherwise. Kept in
 * this module (rather than the editor component) so the reason text stays
 * next to the rule it explains.
 */
export function actionTypeInapplicableReason(actionId: string): string | null {
  switch (actionId) {
    case 'workspace.fork':
      return 'This harness does not support forking a workspace.'
    case 'session.getUsage':
    case 'session.getCost':
      return 'This harness does not report usage/cost data.'
    case 'footer.modelSelect':
      return 'This harness does not expose a model selector.'
    case 'footer.effortSelect':
      return 'This harness does not expose an effort selector.'
    default:
      return null
  }
}

/**
 * Result of checking one action type against EVERY registered harness (not
 * just the one workspace the editor happens to be scoped to). Footer
 * actions are authored at GLOBAL/PROJECT scope, which can apply to
 * workspaces running ANY registered harness — a per-workspace boolean would
 * be misleading in the editor, since "inapplicable to workspace X's
 * harness" does not mean "inapplicable everywhere." `applicableCount` /
 * `totalCount` let a caller render "applies to N of M harnesses" rather
 * than collapsing a partial match down to a lossy true/false.
 */
export interface ActionTypeApplicability {
  /** True only when every registered harness accepts this action type. */
  applicableToAll: boolean
  /** True when no registered harness accepts this action type — the editor
   *  should treat this as a stronger signal than a partial mismatch. */
  applicableToNone: boolean
  applicableCount: number
  totalCount: number
}

/**
 * Checks `actionId` against every harness in `harnesses` (typically the
 * renderer's full harness:list result) — see ActionTypeApplicability's doc
 * comment for why this is N-of-M rather than a single boolean. An empty
 * `harnesses` list (list still loading, or fetch failed) reports
 * applicableToAll/applicableToNone both true with totalCount 0 — a
 * degenerate "no data" case callers should treat the same as "don't gate
 * yet" (mirrors harnessStore.ts's own loading-vs-durably-unknown split;
 * pair with a loading flag when that distinction matters to the caller).
 */
export function actionTypeApplicability(
  actionId: string,
  harnesses: ActionGateHarness[]
): ActionTypeApplicability {
  if (harnesses.length === 0) {
    return { applicableToAll: true, applicableToNone: true, applicableCount: 0, totalCount: 0 }
  }
  const applicableCount = harnesses.filter((h) => isActionTypeApplicable(actionId, h)).length
  return {
    applicableToAll: applicableCount === harnesses.length,
    applicableToNone: applicableCount === 0,
    applicableCount,
    totalCount: harnesses.length
  }
}
