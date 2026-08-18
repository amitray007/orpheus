// ---------------------------------------------------------------------------
// src/main/harness/claude/actions.ts
//
// Claude's default footer quick actions (R8/U6 of the multi-harness
// migration plan). This is DATA ONLY — the exact 8 rows Claude Code ships
// with today, expressed as FooterActionDraft (src/shared/types.ts, the same
// type footer_actions_global/_project/_workspace rows already round-trip
// through — reused deliberately, not duplicated: see footerActions.ts's
// DEFAULT_SEEDS for the existing shape this mirrors).
//
// NOT WIRED INTO SEEDING. `defaultActions` on HarnessDescriptor exists so a
// future per-harness seed path (seeding a newly-created harness's rows the
// first time a workspace on that harness is opened) has real data to read —
// but no such call site exists yet, and this file does not add one.
// footerActions.ts's seedDefaultFooterActions() remains the sole,
// harness-agnostic first-install seeder for footer_actions_global, and this
// file must never be imported by it: doing so would risk re-seeding or
// duplicating a user's already-customised global rows, which is exactly the
// destructive migration U6 is scoped to avoid. See registry.ts's own
// data-only-removal discipline for the same "additive, never destructive"
// spirit applied to harnesses.
//
// These 8 entries are Claude Code SLASH COMMANDS (/copy, /context, /clear)
// plus fork/usage/cost/model/effort — verified against the user's actual
// production footer_actions_global rows. `/copy`/`/context`/`/clear` are
// meaningless as literal terminal text on a harness that isn't Claude; that
// is exactly why gating them behind a harness's descriptor (rather than
// hardcoding them app-wide) matters. See footerActions.ts's gate table for
// how already-stored rows are filtered at list time — a separate, list-time
// concern from this file's seed-time data.
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
