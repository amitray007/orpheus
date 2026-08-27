// ---------------------------------------------------------------------------
// scripts/verify-new-workspace-menu.ts
//
// Assertion harness for src/renderer/src/lib/newWorkspaceMenuLogic.ts — the
// pure logic backing the "+ new workspace" popover's native-overlay port:
// decideHarnessCreateAction (the support-multi-harness rebuild's create
// decision — a harness chip click IS the create action now, given isolation
// mode + which harness was clicked + branch text) and isHarnessRowDisabled
// (the exact predicate decideHarnessCreateAction's 'disabled' branch is
// built on, so the overlay kind's chip `disabled` prop can't drift from the
// click decision).
//
// REMOVED in the harness-selector rebuild: decideCreateAction (superseded by
// decideHarnessCreateAction below) and decideProviderRowIntent/
// decideModelPickAction (hover-vs-pick semantics for the now-deleted
// provider/model list — nothing in this popover hovers or picks a model
// anymore).
//
// REMOVED (dead-code cleanup, same branch): the assertions for
// decideHoverIntentAction/computeSubmenuSide/reduceHoverGate/isGenuineHover/
// reduceRowHover, alongside the reducers themselves and the
// useGenuineHoverGate.ts hook that wrapped them — all of it backed a
// provider -> model flyout submenu that no longer exists anywhere in this
// popover or in the footer Model chip (ChipGroupedDropdown.tsx, removed
// outright). Confirmed dead via grep (zero real imports, only prose
// mentions) before removal.
//
// MUST PASS FULLY OFFLINE — newWorkspaceMenuLogic.ts imports nothing from
// react/electron.
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import {
  decideHarnessCreateAction,
  isHarnessRowDisabled
} from '../src/renderer/src/lib/newWorkspaceMenuLogic.ts'

// ---------------------------------------------------------------------------
// 1. decideHarnessCreateAction — isolation + clicked harness + branch ->
//    create payload. The harness-selector rebuild's central decision: one
//    click on a harness chip both selects it AND creates.
// ---------------------------------------------------------------------------

{
  // Local isolation always creates immediately with whichever harness chip
  // was clicked, regardless of branch text (branch is irrelevant while
  // isolation === 'local').
  const claude = decideHarnessCreateAction('local', 'claude', '')
  assert.deepEqual(claude, { kind: 'local', harnessId: 'claude' })

  const codex = decideHarnessCreateAction('local', 'codex-cli', 'unused-branch-text')
  assert.deepEqual(codex, { kind: 'local', harnessId: 'codex-cli' })

  console.log(
    '✓ local isolation always creates immediately with the CLICKED harness id (branch text irrelevant)'
  )
}

{
  // Worktree isolation with a non-blank branch creates with that (trimmed)
  // branch + the clicked harness.
  const decision = decideHarnessCreateAction('worktree', 'codex-cli', '  my-feature  ')
  assert.deepEqual(decision, { kind: 'worktree', harnessId: 'codex-cli', branch: 'my-feature' })
  console.log(
    '✓ worktree isolation with a non-blank branch creates with the TRIMMED branch text + the clicked harness'
  )
}

{
  // Worktree isolation with an empty/whitespace-only branch is disabled —
  // clicking a harness chip must not silently create with a garbage branch
  // name. This is the exact gate the overlay kind's HarnessRow `disabled`
  // prop encodes (isolation === 'worktree' && !branchValue.trim()).
  assert.deepEqual(decideHarnessCreateAction('worktree', 'claude', ''), { kind: 'disabled' })
  assert.deepEqual(decideHarnessCreateAction('worktree', 'claude', '   '), { kind: 'disabled' })
  console.log(
    '✓ worktree isolation with an empty/whitespace-only branch resolves to "disabled" — never silently creates with a garbage branch name'
  )
}

// ---------------------------------------------------------------------------
// 2. isHarnessRowDisabled — the exact predicate decideHarnessCreateAction's
//    'disabled' branch is built on, extracted so the overlay kind computes
//    each harness chip's `disabled` prop from the SAME logic a click would
//    be evaluated against (see newWorkspaceMenuLogic.ts's own doc comment —
//    this exists specifically to prevent the chip's greyed-out state and
//    the click decision from drifting into two hand-written copies of the
//    same condition).
// ---------------------------------------------------------------------------

{
  assert.equal(isHarnessRowDisabled('local', ''), false)
  assert.equal(isHarnessRowDisabled('local', '   '), false)
  console.log('✓ local isolation never disables the harness chips, regardless of branch text')
}

{
  assert.equal(isHarnessRowDisabled('worktree', ''), true)
  assert.equal(isHarnessRowDisabled('worktree', '   '), true)
  console.log(
    '✓ worktree isolation with an empty/whitespace-only branch disables every harness chip'
  )
}

{
  assert.equal(isHarnessRowDisabled('worktree', 'my-feature'), false)
  console.log('✓ worktree isolation with non-blank branch text enables the harness chips')
}

{
  // End-to-end agreement: for every isolation/branch combination this
  // predicate disagrees with decideHarnessCreateAction only in the
  // direction that's expected — disabled() === true iff the decision is
  // 'disabled'.
  const cases: Array<['local' | 'worktree', string]> = [
    ['local', ''],
    ['local', 'x'],
    ['worktree', ''],
    ['worktree', '   '],
    ['worktree', 'x']
  ]
  for (const [isolation, branch] of cases) {
    const decision = decideHarnessCreateAction(isolation, 'claude', branch)
    assert.equal(isHarnessRowDisabled(isolation, branch), decision.kind === 'disabled')
  }
  console.log(
    '✓ isHarnessRowDisabled agrees with decideHarnessCreateAction across every isolation/branch combination — disabled() is true iff the decision would be "disabled"'
  )
}

console.log('\nAll new-workspace-menu logic assertions passed.')
