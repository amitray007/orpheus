// ---------------------------------------------------------------------------
// actionChipMessages — pure tooltip-message decision for ActionChip.tsx's
// failed-invocation path (support-multi-harness harness-neutral-chrome
// unit).
//
// THE BUG THIS FIXES: main already returns a harness-neutral error string
// for the busy case (src/main/actions/terminal.ts's canInject-gated
// actions: `{ ok: false, code: 'busy', error: 'Workspace is busy' }`), but
// ActionChip.tsx's invokeAction callback special-cased `result.code ===
// 'busy'` and substituted the literal 'Claude is busy' instead of reading
// `result.error` — discarding a correct, already-neutral value from main
// and replacing it with a Claude-specific one, even on a workspace running
// a different harness. Factored out as a pure function (rather than left
// inline in the component) specifically so this exact regression is
// independently assertable by scripts/verify-action-chip-messages.ts
// without mounting React — see that harness's own header for the mutation
// test proving this.
// ---------------------------------------------------------------------------

import type { ActionResultErr } from '@shared/types'

/**
 * The tooltip text to show for a failed action invocation — always
 * `result.error` (main's own message) when present, falling back to a
 * generic 'Action failed' only when main returned no error string at all
 * (should not happen in practice; every ActionResultErr constructor in
 * src/main/actions/ sets `error`, but the type only requires it non-
 * optional so this fallback exists for defense, not because a real path
 * omits it).
 */
export function actionFailureMessage(result: ActionResultErr): string {
  return result.error ?? 'Action failed'
}
