// ---------------------------------------------------------------------------
// src/main/harness/claude/actions.ts
//
// Claude's default footer quick actions (R8/U6 of the multi-harness
// migration plan). This is DATA ONLY — expressed as FooterActionDraft
// (src/shared/types.ts, the same type footer_actions_global/_project/
// _workspace rows already round-trip through — reused deliberately, not
// duplicated).
//
// C5 (support-multi-harness) — DRIFT RESOLUTION: this file previously
// declared its own, DIFFERENT 8-row list (missing Archive/Rename/`/compact`/
// `/cost`, and using session.getUsage+session.getCost where the real seed
// used a `/cost` slash command) while footerActions.ts's DEFAULT_SEEDS —
// the list that ACTUALLY seeds every real install via
// seedDefaultFooterActions() — carried the real, shipped 11 rows. Nothing
// ever read this file's list (verify-harness-actions.ts asserted exactly
// that), so the two silently diverged with zero user impact, but ALSO zero
// value: this file was dead weight duplicating data it didn't even agree
// with.
//
// CLAUDE_DEFAULT_ACTIONS is now THE canonical source, verified against the
// user's actual production footer_actions_global rows (11 entries) —
// footerActions.ts's DEFAULT_SEEDS derives FROM this array (mapped into its
// own on-disk seed-row shape) rather than restating it, so the two tables
// can never drift apart again. Picking this file (not footerActions.ts) as
// the canonical location matches the multi-harness design: a harness's
// default actions belong on ITS OWN descriptor module, not in the
// generic cross-harness storage module — footerActions.ts should know
// nothing Claude-specific.
//
// SEEDING: seedDefaultFooterActionsForHarness() in footerActions.ts reads
// descriptor.defaultActions (this array, via registry.ts's CLAUDE_DESCRIPTOR)
// to seed a harness's rows the first time footer_actions_global has zero
// rows STAMPED FOR THAT HARNESS — see that function's own header for the
// per-harness idempotency contract and why it can never duplicate or
// clobber a user's existing rows.
//
// These 11 entries are Claude Code SLASH COMMANDS (/copy, /context, /clear,
// /compact, /cost) plus fork/model/effort/archive/rename — `/copy`/
// `/context`/`/clear`/`/compact`/`/cost` are meaningless as literal terminal
// text on a harness that isn't Claude; that is exactly why gating them
// behind a harness's descriptor (rather than hardcoding them app-wide)
// matters. See footerActions.ts's gate table for how already-stored rows
// are filtered at list time by provenance — a separate, list-time concern
// from this file's seed-time data.
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
    label: '/compact',
    icon: 'ArrowsInLineHorizontal',
    actionId: SEND_INPUT,
    params: { text: '/compact', submit: true },
    visibleWhen: 'idle'
  },
  {
    label: '/cost',
    icon: 'CurrencyDollar',
    actionId: SEND_INPUT,
    params: { text: '/cost', submit: true },
    visibleWhen: 'always'
  },
  {
    label: 'Model',
    icon: 'Robot',
    actionId: 'footer.modelSelect',
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
    label: 'Archive',
    icon: 'Archive',
    actionId: 'workspace.archive',
    params: {},
    visibleWhen: 'idle'
  },
  {
    label: 'Rename',
    icon: 'PencilSimple',
    actionId: 'workspace.rename',
    params: {},
    visibleWhen: 'idle',
    prompts: [
      {
        key: 'name',
        label: 'New name',
        placeholder: 'Workspace name',
        default: '{workspaceName}'
      }
    ]
  },
  {
    label: 'Context',
    icon: 'Gauge',
    actionId: 'session.getUsage',
    params: {},
    visibleWhen: 'always'
  }
]
