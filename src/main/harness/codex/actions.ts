// ---------------------------------------------------------------------------
// src/main/harness/codex/actions.ts
//
// Codex's default footer quick actions — the Codex sibling of
// src/main/harness/claude/actions.ts. Read that file's header first: its
// 8-row CLAUDE_DEFAULT_ACTIONS list was settled by inspecting a REAL,
// actively-used production database, which is the only evidence that
// settled what a fresh Claude install should ship with.
//
// There is no equivalent evidence for Codex — no production install has
// ever run this descriptor, so there is nothing to inspect. Rather than
// guess a Claude-shaped list and risk seeding rows for features Codex
// cannot actually perform, this file ships a DELIBERATELY CONSERVATIVE set:
// only actions whose underlying capability CODEX_CAPABILITIES (./curated.ts)
// actually declares true, and only actions with no dependency on plumbing
// this unit knows is unwired.
//
// WHAT'S INCLUDED AND WHY:
//   - Model / Effort pickers (footer.modelSelect / footer.effortSelect) —
//     safe. CODEX_CURATED.model/.effort (./curated.ts) are real, working
//     curated fields; these two actions are generic footer actions that
//     read/write whichever harness's curated fields are present, gated by
//     footerActions.ts's own action-id gate table on
//     "curated.model"/"curated.effort" being declared — which they are.
//   - Fork (workspace.fork) — safe on capability grounds:
//     CODEX_CAPABILITIES.fork is true (see curated.ts's doc comment on that
//     flag for the "capability real, launch-side wiring deferred to C5"
//     distinction). The action itself is a generic workspace-lifecycle
//     action gated on capabilities.fork by footerActions.ts's gate table,
//     not on any Codex-specific wiring this unit would need to add.
//
// WHAT'S DELIBERATELY EXCLUDED AND WHY:
//   - /copy, /context, /clear (Claude slash commands sent as literal
//     terminal text) — meaningless (or actively wrong) as text typed into a
//     Codex REPL; Claude's actions.ts header makes exactly this point about
//     why these are gated per-descriptor rather than hardcoded app-wide.
//     Codex's own REPL command surface is unverified (see curated.ts's
//     liveApply comment) — this unit does not know what Codex's equivalent
//     commands even are, so it ships none rather than guessing wrong ones.
//   - Context (session.getUsage) / Cost (session.getCost) — these read
//     Claude-specific usage/cost accounting (claudeActivityWindow.ts parses
//     Claude's own transcript JSONL for token counts — see
//     CLAUDE_CAPABILITIES.usage's doc comment in harness/claude/curated.ts).
//     CODEX_CAPABILITIES.usage is true (Codex genuinely reports usage in its
//     own output), but nothing in Orpheus yet parses IT — session.getUsage/
//     session.getCost are Claude-transcript-shaped handlers, not generic
//     ones, and wiring a Codex-shaped equivalent is out of this unit's
//     scope (B1-B3: build the module, not the usage-parsing pipeline).
//     Shipping these two rows today would silently no-op or error for every
//     Codex workspace.
//   - Archive / Rename — not part of Claude's own settled 8-row list either
//     (see that file's header); no reason to add them here that wasn't
//     already true for Claude.
// ---------------------------------------------------------------------------

import type { FooterActionDraft } from '../../../shared/types'

// ORDER IS THE RENDER ORDER. Rows are seeded at ascending `position` and the
// footer renders `ORDER BY position ASC`, so this array literally is what the
// user sees left-to-right.
//
// Model -> Effort -> Fork mirrors the arrangement a real Claude install
// converged on (Model and Effort lead because they are the two chips users
// actually change; Fork is occasional). Codex originally shipped the reverse
// — Fork, Effort, Model — which put the least-used control first and read as
// broken next to a Claude workspace's footer.
//
// NOTE for anyone comparing this against CLAUDE_DEFAULT_ACTIONS: that array
// still begins with Fork. It is NOT the contradiction it looks like — a real
// install's Claude rows are USER-REORDERED (verified in the dev DB: Model at
// position 0, Fork at 2, against a seed array that starts with Fork), and
// reseeding never rewrites an existing row's position. This array is the
// FRESH-INSTALL order for Codex, chosen to match what that reordering
// settled on rather than to match Claude's untouched seed array.
export const CODEX_DEFAULT_ACTIONS: FooterActionDraft[] = [
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
    label: 'Fork',
    icon: 'GitFork',
    actionId: 'workspace.fork',
    params: {},
    visibleWhen: 'always'
  }
]
