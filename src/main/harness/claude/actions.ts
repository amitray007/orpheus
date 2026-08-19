// ---------------------------------------------------------------------------
// src/main/harness/claude/actions.ts
//
// Claude's default footer quick actions (R8/U6 of the multi-harness
// migration plan). This is DATA ONLY — expressed as FooterActionDraft
// (src/shared/types.ts, the same type footer_actions_global/_project/
// _workspace rows already round-trip through — reused deliberately, not
// duplicated).
//
// C5 (support-multi-harness) — DRIFT RESOLUTION, settled by REAL DATA:
// this file's list and footerActions.ts's own DEFAULT_SEEDS had silently
// diverged (this file: 8 rows, no Archive/Rename/`/compact`/`/cost`, using
// session.getUsage+session.getCost; DEFAULT_SEEDS: 11 rows, with `/compact`
// and `/cost` as slash-command rows instead). Nothing ever read this file's
// list before C5 (verify-harness-actions.ts asserted exactly that), so an
// initial guess at which side was "real" was made by inspecting the DEV
// database — which favored the 11-row DEFAULT_SEEDS shape.
//
// That guess was WRONG. A read-only inspection of the user's actual
// PRODUCTION database (~/Library/Application Support/orpheus/orpheus.sqlite)
// during this unit's review found their real footer_actions_global has
// exactly 8 rows: Model, Effort, Fork, /copy, /context, /clear, Context
// (session.getUsage), Cost (session.getCost) — i.e. almost exactly THIS
// file's original 8-row list, not DEFAULT_SEEDS' 11. The user had
// deliberately deleted `/compact`, `/cost`, Archive, and Rename from their
// footer. CLAUDE_DEFAULT_ACTIONS is therefore restored to (and remains) the
// canonical 8-row set — it is what a real, actively-used install actually
// converged on, which is the only evidence that matters for "what should a
// FRESH install ship with".
//
// footerActions.ts's DEFAULT_SEEDS now derives FROM this array (mapped into
// its own on-disk seed-row shape) rather than restating it, so the two
// tables can never drift apart again — this is the part of the original
// resolution that stands regardless of which content won: one array, one
// place it's declared, everything else derives from it. Picking this file
// (not footerActions.ts) as the canonical location matches the
// multi-harness design: a harness's default actions belong on ITS OWN
// descriptor module, not in the generic cross-harness storage module —
// footerActions.ts should know nothing Claude-specific.
//
// CRITICAL: this content choice affects ONLY a harness/install with ZERO
// existing rows. seedDefaultFooterActions()/seedDefaultFooterActionsForHarness
// in footerActions.ts are both gated on "does footer_actions_global already
// have ANY row" (see that file's own header) — never on whether the
// existing row count/shape matches this array. The user whose real 8-row,
// deliberately-pruned footer prompted this correction is UNAFFECTED by
// either version of this list: their rows are seeded-once, NULL-provenance,
// and this migration never touches, reseeds, or evaluates them against
// CLAUDE_DEFAULT_ACTIONS at all — see scripts/verify-footer-actions.ts's
// real-user-shaped fixture (modeled on their exact 8 rows) for the assertion
// that pins this.
//
// SEEDING: seedDefaultFooterActionsForHarness() in footerActions.ts reads
// descriptor.defaultActions (this array, via registry.ts's CLAUDE_DESCRIPTOR)
// to seed a harness's rows the first time footer_actions_global has zero
// rows STAMPED FOR THAT HARNESS — see that function's own header for the
// per-harness idempotency contract and why it can never duplicate or
// clobber a user's existing rows.
//
// These 8 entries are Claude Code SLASH COMMANDS (/copy, /context, /clear)
// plus fork/usage/cost/model/effort — `/copy`/`/context`/`/clear` are
// meaningless as literal terminal text on a harness that isn't Claude; that
// is exactly why gating them behind a harness's descriptor (rather than
// hardcoding them app-wide) matters. See footerActions.ts's gate table for
// how already-stored rows are filtered at list time by provenance — a
// separate, list-time concern from this file's seed-time data.
// ---------------------------------------------------------------------------

import type { FooterActionDraft } from '../../../shared/types'

const SEND_INPUT = 'terminal.sendInput'

export const CLAUDE_DEFAULT_ACTIONS: FooterActionDraft[] = [
  {
    label: 'Fork',
    icon: 'GitFork',
    actionId: 'workspace.fork',
    params: {},
    visibleWhen: 'always'
  },
  {
    label: '/copy',
    icon: 'Clipboard',
    actionId: SEND_INPUT,
    params: { text: '/copy', submit: true },
    visibleWhen: 'idle'
  },
  {
    label: '/context',
    icon: 'Brain',
    actionId: SEND_INPUT,
    params: { text: '/context', submit: true },
    visibleWhen: 'always'
  },
  {
    label: '/clear',
    icon: 'Eraser',
    actionId: SEND_INPUT,
    params: { text: '/clear', submit: true },
    visibleWhen: 'idle'
  },
  {
    label: 'Context',
    icon: 'Gauge',
    actionId: 'session.getUsage',
    params: {},
    visibleWhen: 'always'
  },
  {
    label: 'Cost',
    icon: 'CurrencyDollar',
    actionId: 'session.getCost',
    params: {},
    visibleWhen: 'always'
  },
  {
    label: 'Effort',
    icon: 'Sliders',
    actionId: 'footer.effortSelect',
    params: {},
    visibleWhen: 'always'
  },
  {
    label: 'Model',
    icon: 'Robot',
    actionId: 'footer.modelSelect',
    params: {},
    visibleWhen: 'always'
  }
]
