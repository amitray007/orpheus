// ---------------------------------------------------------------------------
// scripts/verify-new-workspace-menu.ts
//
// Assertion harness for src/renderer/src/lib/newWorkspaceMenuLogic.ts — the
// pure logic backing the "+ new workspace" popover's native-overlay port
// (model-routing unit 10-creation): decideCreateAction (rule 4's inversion —
// the top line/Enter is the SOLE create action), decideHoverIntentAction
// (the PROVIDER -> MODEL FLYOUT SUBMENU's own diagonal-traversal fix — the
// top-level trigger is click-only and has NO hover-intent timer at all
// anymore), computeSubmenuSide (the submenu's left/right flip decision),
// reduceHoverGate/isGenuineHover (the phantom-hover-from-resize fix — see
// their doc comments in newWorkspaceMenuLogic.ts for the full root-cause
// story: this popover's own resize, not real user input, was cascading into
// a self-sustaining submenu open/close/reassign loop), and
// decideProviderRowIntent/decideModelPickAction (the two post-ship bug
// fixes: hovering a provider row must NOT commit the top-line selection, and
// picking a model must NOT close the submenu — see both functions' doc
// comments in newWorkspaceMenuLogic.ts).
//
// MUST PASS FULLY OFFLINE — newWorkspaceMenuLogic.ts imports nothing from
// react/electron, mirroring verify-creation-provider-menu.ts's own
// no-Electron/no-DB constraint.
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import {
  decideCreateAction,
  decideHoverIntentAction,
  computeSubmenuSide,
  reduceHoverGate,
  isGenuineHover,
  decideProviderRowIntent,
  decideModelPickAction,
  reduceRowHover,
  type HoveredRow
} from '../src/renderer/src/lib/newWorkspaceMenuLogic.ts'

// ---------------------------------------------------------------------------
// 1. decideCreateAction — isolation + selection + branch -> create payload.
// ---------------------------------------------------------------------------

{
  // Local isolation always creates, regardless of branch text (branch is
  // irrelevant while isolation === 'local') — undefined model means "use the
  // global/project default", unchanged pre-existing behavior.
  const noModel = decideCreateAction('local', undefined, '')
  assert.deepEqual(noModel, { kind: 'local', modelId: undefined })

  const withModel = decideCreateAction('local', 'gpt-5-codex', '')
  assert.deepEqual(withModel, { kind: 'local', modelId: 'gpt-5-codex' })

  // null selectedModelId (never explicitly picked) normalizes the same as
  // undefined — both mean "use the default".
  const nullModel = decideCreateAction('local', null, '')
  assert.deepEqual(nullModel, { kind: 'local', modelId: undefined })

  console.log(
    '✓ local isolation always creates immediately (branch text irrelevant); undefined/null selectedModelId both mean "use the global/project default"'
  )
}

{
  // Worktree isolation with a non-blank branch creates with that (trimmed)
  // branch + the current model selection.
  const decision = decideCreateAction('worktree', 'grok-4.5', '  my-feature  ')
  assert.deepEqual(decision, { kind: 'worktree', modelId: 'grok-4.5', branch: 'my-feature' })
  console.log(
    '✓ worktree isolation with a non-blank branch creates with the TRIMMED branch text + current model selection'
  )
}

{
  // Worktree isolation with an empty/whitespace-only branch is disabled —
  // Enter/click on the top line must not silently create with a garbage
  // branch name. This is the exact gate the overlay kind's TopLine
  // `disabled` prop encodes (isolation === 'worktree' && !branchValue.trim()).
  assert.deepEqual(decideCreateAction('worktree', 'gpt-5-codex', ''), { kind: 'disabled' })
  assert.deepEqual(decideCreateAction('worktree', 'gpt-5-codex', '   '), { kind: 'disabled' })
  console.log(
    '✓ worktree isolation with an empty/whitespace-only branch resolves to "disabled" — never silently creates with a garbage branch name'
  )
}

// ---------------------------------------------------------------------------
// 2. decideHoverIntentAction — the PROVIDER -> MODEL FLYOUT SUBMENU's own
//    diagonal-traversal fix.
//
//    NOTE ON SCOPE: this reducer is no longer wired to the top-level "+"
//    trigger at all — that trigger is CLICK-ONLY now (see
//    src/renderer/src/components/dashboard/NewWorkspaceMenu.tsx's
//    handleTriggerClick, which has no onMouseEnter/onMouseLeave handlers,
//    and the wrapper div, which no longer has ANY mouse listeners). The
//    event names ('enterTrigger'/'enterCard' etc.) are kept generic because
//    the underlying shape didn't change — only WHAT plays the "trigger"/
//    "card" role did: a provider ROW instead of the whole popover's "+"
//    button, and the model SUBMENU instead of the whole popover card. These
//    assertions therefore describe the submenu's open/switch/close-delay/
//    cancel-on-enter behavior, not the trigger's (the trigger no longer HAS
//    hover-intent behavior to assert — clicking it is a plain, untimed
//    toggle, already covered by decideCreateAction's sibling call-site logic
//    needing no pure-logic assertion of its own beyond "click = toggle").
// ---------------------------------------------------------------------------

{
  // Hovering a provider row when no submenu is open yet schedules an open;
  // hovering a row again (or a DIFFERENT row, re-targeting the same open
  // submenu — the call site treats "switch to a different provider" as this
  // same isOpen===true path) while a submenu is ALREADY open just cancels
  // any pending close rather than rescheduling a redundant open — this is
  // exactly how the submenu "switches" between rows without a close/reopen
  // flicker.
  assert.deepEqual(decideHoverIntentAction('enterTrigger', false), { type: 'scheduleOpen' })
  assert.deepEqual(decideHoverIntentAction('enterTrigger', true), { type: 'cancelTimer' })
  console.log(
    '✓ entering a provider row schedules the submenu open when none is open yet; entering a row while a submenu is ALREADY open (same row or a different one) just cancels any pending close — no redundant reschedule, no flicker when switching rows'
  )
}

{
  // Leaving a provider row always schedules a close, whether a submenu ended
  // up open or not.
  assert.deepEqual(decideHoverIntentAction('leaveTrigger', true), { type: 'scheduleClose' })
  assert.deepEqual(decideHoverIntentAction('leaveTrigger', false), { type: 'scheduleClose' })
  console.log('✓ leaving a provider row always schedules a close')
}

{
  // THE crux bug fix (the classic "diagonal traversal into a submenu"
  // problem every hierarchical menu has to solve): reaching the submenu
  // itself (across the row-to-flyout gap) must CANCEL any close scheduled
  // by a prior leaveTrigger (leaving the row on the way to the submenu) —
  // never let the submenu vanish out from under an in-transit pointer.
  assert.deepEqual(decideHoverIntentAction('enterCard', true), { type: 'cancelTimer' })
  console.log(
    '✓ enterCard (reaching the submenu) cancels any pending close — THE diagonal-traversal fix: crossing the row-to-flyout gap must never let a leaveTrigger close-timer fire first'
  )
}

{
  // leaveCard re-arms the SAME close path leaveTrigger would have scheduled
  // — leaving via the submenu behaves identically to leaving via the row,
  // no special "the submenu is somehow stickier" asymmetry.
  assert.deepEqual(decideHoverIntentAction('leaveCard', true), { type: 'scheduleClose' })
  assert.deepEqual(
    decideHoverIntentAction('leaveTrigger', true),
    decideHoverIntentAction('leaveCard', true)
  )
  console.log(
    '✓ leaveCard (leaving the submenu) re-arms the SAME close scheduling as leaveTrigger (leaving the row) — leaving via either panel is symmetric'
  )
}

{
  // click bypasses the delay machinery entirely — toggles immediately. Kept
  // as a decision the reducer can express (used by e.g. click-to-open-
  // submenu affordances elsewhere in the menu vocabulary), independent of
  // the top-level trigger's own click handling which lives directly in the
  // call site, not through this reducer.
  assert.deepEqual(decideHoverIntentAction('click', false), { type: 'toggleImmediate' })
  assert.deepEqual(decideHoverIntentAction('click', true), { type: 'toggleImmediate' })
  console.log(
    '✓ click always resolves to an immediate toggle regardless of open state — bypasses the hover-delay machinery entirely'
  )
}

// ---------------------------------------------------------------------------
// 3. computeSubmenuSide — the flyout's left/right flip decision.
// ---------------------------------------------------------------------------

{
  // Plenty of room on the right (typical case) — opens right, the preferred
  // side, matching every macOS/VS Code-style nested menu.
  const side = computeSubmenuSide({
    parentPanelLeft: 100,
    parentPanelWidth: 256,
    submenuWidth: 256,
    screenWidth: 1440,
    gap: 6
  })
  assert.equal(side, 'right')
  console.log('✓ opens to the right when there is room — the preferred side')
}

{
  // Parent panel sits flush against the right edge of the screen (no room
  // for a same-width submenu to its right) but plenty of room to the left —
  // flips left.
  const side = computeSubmenuSide({
    parentPanelLeft: 1300,
    parentPanelWidth: 256,
    submenuWidth: 256,
    screenWidth: 1440,
    gap: 6
  })
  assert.equal(side, 'left')
  console.log(
    '✓ flips to the LEFT of the parent panel when the right side does not have room, matching the requested "flip to the left" behavior'
  )
}

{
  // Neither side has room (a pathologically narrow/small screen) — falls
  // back to 'right' (best-effort; the overlay window's OWN clamp,
  // src/main/overlayLayer.ts's computeAnchoredPlacement, still keeps the
  // resulting wider card on-screen as a whole).
  const side = computeSubmenuSide({
    parentPanelLeft: 100,
    parentPanelWidth: 256,
    submenuWidth: 256,
    screenWidth: 300,
    gap: 6
  })
  assert.equal(side, 'right')
  console.log(
    '✓ falls back to "right" when NEITHER side has room (pathologically narrow screen) — the overall card is still clamped on-screen by the existing overlay placement machinery'
  )
}

{
  // Exact boundary — room for right is exactly zero slack: fits precisely.
  const side = computeSubmenuSide({
    parentPanelLeft: 0,
    parentPanelWidth: 100,
    submenuWidth: 200,
    screenWidth: 306, // 0 + 100 + 6 + 200 === 306
    gap: 6
  })
  assert.equal(side, 'right')
  console.log('✓ an exact-fit right side (zero slack) still counts as "fits" — opens right')
}

// ---------------------------------------------------------------------------
// 4. reduceHoverGate / isGenuineHover — the phantom-hover-from-resize fix.
//    Root cause (proven via runtime instrumentation, not guessed): this
//    popover's card grows when a submenu opens, which grows the host
//    BrowserWindow, which moves the window under a STATIONARY OS cursor —
//    Chromium then fires a genuine but spurious native mouseenter for
//    whatever element the resize left under the cursor. Left untreated this
//    cascades (phantom hover -> opens a different submenu -> resizes again
//    -> phantom hover on yet another row -> ...), observed live as
//    hoverProvider firing repeatedly across every provider with no real
//    input at all — the mechanism behind "I see it for a split second and
//    then it's gone".
// ---------------------------------------------------------------------------

{
  // A resize ALWAYS clears the "genuinely hovered" flag, independent of
  // prior state — a window-geometry change (real or not) must never be
  // mistaken for consent to open something.
  assert.equal(reduceHoverGate('resize'), false)
  console.log(
    '✓ a resize always clears the genuine-hover flag — the ONLY thing a resize can do is revoke trust'
  )
}

{
  // A real mousemove ALWAYS sets the flag — the only event that can re-arm
  // trust after a resize.
  assert.equal(reduceHoverGate('mousemove'), true)
  console.log(
    '✓ a real mousemove always re-arms the genuine-hover flag — the ONLY event that can restore trust after a resize'
  )
}

{
  // isGenuineHover is a straight passthrough of the gate flag — a mouseenter
  // is trusted iff the pointer has genuinely moved since the last resize.
  assert.equal(isGenuineHover(true), true)
  assert.equal(isGenuineHover(false), false)
  console.log(
    '✓ isGenuineHover trusts a hover iff the pointer has moved since the last resize — false immediately after a resize with no intervening real mousemove'
  )
}

{
  // The exact sequence that reproduced the bug: open (resize) -> submenu
  // opens (resize again, cursor never moved) -> a mouseenter fires on
  // whatever the second resize left under the stationary cursor. Without
  // an intervening mousemove, that mouseenter must be rejected.
  let moved = true // fresh popover, cursor arrived via a real click
  moved = reduceHoverGate('resize') // DEFAULT_ANCHORED shows -> false
  moved = reduceHoverGate('resize') // reportSize shrink -> still false
  assert.equal(isGenuineHover(moved), false)
  console.log(
    '✓ end-to-end: two resizes with no intervening mousemove (the exact "window settling" sequence that produced the observed phantom-hover cascade) leaves the gate closed'
  )
}

// ---------------------------------------------------------------------------
// 5. decideProviderRowIntent / decideModelPickAction — the two post-ship bug
//    fixes reported by the user:
//
//    Bug A: "hovering over the model provider name like openai, changes the
//    selected model on top, this is bad, unless I select a model it
//    shouldn't." Hover must NEVER commit the top-line (create-payload)
//    selection — only an explicit pick (click, or ArrowRight/Enter into the
//    row) may.
//
//    Bug B: "On selecting model, make sure popover doesn't close as I need
//    to select the selected model thing too." Picking a model is only a STEP
//    toward the top-line create action now (not the action itself, per the
//    create-action inversion) — it must commit the selection WITHOUT closing
//    the submenu.
// ---------------------------------------------------------------------------

{
  // Bug A fix: a mere hover on a provider row must NOT commit anything to
  // the top line — it only ever previews/switches the flyout submenu.
  const hover = decideProviderRowIntent('hover')
  assert.deepEqual(hover, { commitsSelection: false, keepsSubmenuOpen: true })
  console.log(
    '✓ Bug A fix: hovering a provider row does NOT commit the top-line selection — only opens/switches the submenu preview'
  )
}

{
  // An explicit pick (click, or ArrowRight/Enter navigating INTO the row) IS
  // deliberate user intent, unlike a hover — this DOES commit that
  // provider's last-used model to the top line. (Design decision: my lean,
  // confirmed — an explicit action on the row is a reasonable proxy for "I
  // want this provider", whereas a hover is purely incidental mouse
  // transit.)
  const pick = decideProviderRowIntent('pick')
  assert.deepEqual(pick, { commitsSelection: true, keepsSubmenuOpen: true })
  console.log(
    '✓ an explicit pick on a provider row (click / ArrowRight / Enter-into-row) DOES commit its last-used model to the top line — deliberate action, unlike a hover'
  )
}

{
  // Bug B fix: picking a SPECIFIC model always commits the selection AND
  // always keeps the submenu open — the opposite of the old conventional-
  // menu behavior (leaf pick closes the menu), which broke the create-action
  // inversion by hiding the very top line the user still needs to click.
  const modelPick = decideModelPickAction()
  assert.deepEqual(modelPick, { commitsSelection: true, keepsSubmenuOpen: true })
  console.log(
    '✓ Bug B fix: picking a model commits the selection to the top line AND leaves the submenu OPEN — the user still needs to reach the top line to actually create'
  )
}

// ---------------------------------------------------------------------------
// 6. reduceRowHover — the "three rows stuck highlighted at once" fix.
//    ROOT CAUSE (confirmed via code inspection, not guessed): both
//    ProviderRow and SubmenuPanel's model rows carried a CSS
//    `hover:bg-surface-raised` pseudo-class IN ADDITION TO the JS-tracked
//    highlighted index. `:hover` is evaluated by Chromium off live
//    window/cursor geometry and is NOT an event this component intercepts —
//    it completely bypassed the existing genuine-hover gate
//    (reduceHoverGate/isGenuineHover above), which was built specifically to
//    stop this popover's own resizes (submenu open growing the card growing
//    the host BrowserWindow under a stationary cursor) from being misread as
//    user input. Because `:hover` is a continuously-recomputed pseudo-class
//    rather than a discrete event, intermediate resize frames could leave
//    MORE THAN ONE row simultaneously matching `:hover` as the window
//    settled — reproducing the reported "three rows painted while the
//    pointer is elsewhere" bug. The fix replaces `hover:` entirely with a
//    single JS-tracked `HoveredRow` value gated through the same
//    isGenuineHover check, which these assertions cover.
// ---------------------------------------------------------------------------

{
  // Structural guarantee: HoveredRow is `{ panel, index } | null` — a SINGLE
  // optional value, not a per-row boolean array. There is no representable
  // state with two rows hovered at once; this is what makes "at most one
  // highlighted row" true by construction rather than by convention.
  const a: HoveredRow = { panel: 'providers', index: 2 }
  const b: HoveredRow = null
  assert.equal(typeof a, 'object')
  assert.equal(b, null)
  console.log(
    '✓ HoveredRow is a single optional {panel,index} value — structurally impossible to represent two hovered rows at once'
  )
}

{
  // A GENUINE pointerEnter sets the hovered row from nothing.
  const next = reduceRowHover(
    { type: 'pointerEnter', panel: 'providers', index: 1, genuine: true },
    null
  )
  assert.deepEqual(next, { panel: 'providers', index: 1 })
  console.log('✓ a genuine pointerEnter sets the hovered row')
}

{
  // THE crux fix: a NON-genuine pointerEnter (the window's own resize left
  // this row under a stationary cursor, no real mousemove happened) must be
  // REJECTED — the current hovered row (whatever it was) is left untouched,
  // never replaced by the phantom. This is the exact mechanism that used to
  // let a resize paint a row with no real input at all.
  const current: HoveredRow = { panel: 'providers', index: 0 }
  const next = reduceRowHover(
    { type: 'pointerEnter', panel: 'providers', index: 3, genuine: false },
    current
  )
  assert.deepEqual(next, current)
  console.log(
    "✓ a NON-genuine pointerEnter (phantom hover from the window's own resize) is REJECTED — the current hovered row is left untouched, never replaced by the phantom"
  )
}

{
  // pointerLeave only clears the hovered row when it matches the row that is
  // leaving — a stale/out-of-order leave for a row that is no longer the
  // current hover must not clobber a newer hover.
  const current: HoveredRow = { panel: 'models', index: 2 }
  const matchingLeave = reduceRowHover({ type: 'pointerLeave', panel: 'models', index: 2 }, current)
  assert.equal(matchingLeave, null)

  const staleLeave = reduceRowHover({ type: 'pointerLeave', panel: 'models', index: 0 }, current)
  assert.deepEqual(staleLeave, current)
  console.log(
    '✓ pointerLeave only clears the hovered row when it matches the CURRENT hovered row — a stale leave for a row that is no longer current does not clobber a newer hover'
  )
}

{
  // clear unconditionally resets to no hover, regardless of current state —
  // used for window resize, submenu provider switch, and popover close.
  assert.equal(reduceRowHover({ type: 'clear' }, { panel: 'providers', index: 4 }), null)
  assert.equal(reduceRowHover({ type: 'clear' }, null), null)
  console.log(
    '✓ "clear" unconditionally resets the hovered row to null — the shared clear-point for resize / provider-switch / popover-close'
  )
}

{
  // End-to-end: a resize clears whatever was hovered (phantom hover cannot
  // paint a row after this point without an intervening genuine mousemove),
  // matching this popover's actual wiring (useGenuineHoverGate's onResize
  // callback calls reduceRowHover({type:'clear'}, current) from the SAME
  // native 'resize' listener that closes the isGenuineHover gate).
  let hovered: HoveredRow = { panel: 'models', index: 5 }
  hovered = reduceRowHover({ type: 'clear' }, hovered) // window resize fires
  assert.equal(hovered, null)
  // A pointerenter immediately after, with no intervening real mousemove
  // (isGenuineHover(false)), must still be rejected — matches the exact
  // "window settling" sequence from the phantom-hover-gate section above.
  hovered = reduceRowHover(
    { type: 'pointerEnter', panel: 'models', index: 5, genuine: isGenuineHover(false) },
    hovered
  )
  assert.equal(hovered, null)
  console.log(
    '✓ end-to-end: a resize clears the hovered row, and a subsequent pointerEnter with no intervening real mousemove stays rejected — a resize alone can never leave (or repaint) a stuck highlighted row'
  )
}

{
  // Mouse hover and keyboard highlight converge: hovering a DIFFERENT panel
  // than the one currently hovered simply retargets to that panel/index
  // (e.g. the call site treats this as "the view switched, and the new
  // panel's row genuinely got hovered") — there is still only ever one
  // HoveredRow value, never two independent panel-scoped hovers alive at
  // once.
  let hovered: HoveredRow = { panel: 'providers', index: 1 }
  hovered = reduceRowHover(
    { type: 'pointerEnter', panel: 'models', index: 0, genuine: true },
    hovered
  )
  assert.deepEqual(hovered, { panel: 'models', index: 0 })
  console.log(
    "✓ hovering a row in a different panel retargets the single HoveredRow value rather than tracking two panels' hovers simultaneously"
  )
}

console.log('\nAll new-workspace-menu logic assertions passed.')
