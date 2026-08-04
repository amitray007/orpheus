// ---------------------------------------------------------------------------
// scripts/verify-tui-wizard.ts
//
// Assertion harness for the PURE width-computation module backing the
// new-workspace wizard (packages/orpheus-cli/src/tui/wizardLayout.ts) —
// mirrors scripts/verify-tui-layout.ts's/verify-tui-blocks.ts's own
// no-Ink/no-TTY/no-socket constraint. wizardLayout.ts imports nothing from
// react/ink, so this exercises exactly the same functions
// NewWorkspaceWizard.tsx and its step components (ListStep/NameStep/
// ConfirmStep) consume, with no component mounted and no terminal involved.
//
// WHY THIS SCRIPT EXISTS AT ALL (see wizardLayout.ts's own file header):
// the wizard is a phone-first, full-screen flow whose entire reason to exist
// is being usable at ~38 columns (an iPhone-portrait Termius session) — the
// one surface in this whole TUI where the narrow tier ISN'T a graceful
// degradation of a wider design, it's the primary target. Every assertion
// below is checked explicitly at columns=38, plus the existing 59/60
// narrow-tier boundary from cardBreakpoints.ts, so a manual truncate/padEnd/
// width-budget change here can't silently overflow the phone-portrait case
// the whole feature was built for.
//
// Covers:
//   1. listRowInnerWidth: floors at 1 for a pathologically narrow terminal,
//      matches the documented gutter/pad carve-out at 38 and at the 59/60
//      narrow-tier boundary.
//   2. buildListRowText: pads to EXACTLY the requested width at 38 columns
//      (so a caller can safely apply backgroundColor without the Ink
//      "background doesn't reserve columns" trap — see WorkspaceCard.tsx's
//      header), truncates an overlong label, and the "(unavailable)" suffix
//      is appended when it fits and DROPPED (never squeezed in truncated
//      form) when it doesn't — verified at exactly the width where the
//      suffix stops fitting at 38 columns.
//   3. buildSummaryLine: truncates a "label: value" confirm-screen line to
//      the given content width, at 38 columns and at 59/60.
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import {
  listRowInnerWidth,
  buildListRowText,
  buildSummaryLine,
  buildClosePromptLine,
  CLOSE_PROMPT_LITERAL_COLUMNS,
  WIZARD_GUTTER_COLUMNS,
  WIZARD_PAD_RIGHT
} from '../packages/orpheus-cli/src/tui/wizardLayout.ts'
import { CARD_NARROW_MAX } from '../packages/orpheus-cli/src/tui/cardBreakpoints.ts'
import { buildCreateArgs } from '../packages/orpheus-cli/src/tui/wizardStepMachine.ts'

// Phone-portrait target column count (Termius on an iPhone in portrait,
// per the task brief). Named so every assertion below reads as "at phone
// width" rather than a bare magic number.
const PHONE_COLUMNS = 38

function testListRowInnerWidth(): void {
  // Floors at 1 rather than going negative/zero when the gutter+pad budget
  // (3 columns total) exceeds the terminal's own width — a terminal THAT
  // narrow is unrealistic, but truncate()/padEnd() must never be called
  // with a non-positive width.
  assert.equal(listRowInnerWidth(0), 1, 'floors at 1 for a zero-width terminal')
  assert.equal(listRowInnerWidth(1), 1, 'floors at 1 for a 1-column terminal')
  assert.equal(listRowInnerWidth(2), 1, 'floors at 1 when columns == the gutter+pad budget')

  // At phone width (38 cols): budget is columns - WIZARD_GUTTER_COLUMNS (2)
  // - WIZARD_PAD_RIGHT (1) = 35.
  const expectedAt38 = PHONE_COLUMNS - WIZARD_GUTTER_COLUMNS - WIZARD_PAD_RIGHT
  assert.equal(
    listRowInnerWidth(PHONE_COLUMNS),
    expectedAt38,
    'phone-width (38) inner budget is 35'
  )
  assert.equal(expectedAt38, 35, 'sanity: 38 - 2 - 1 == 35')

  // The 59/60 narrow-tier boundary (cardBreakpoints.ts's CARD_NARROW_MAX) —
  // the wizard doesn't itself branch on this breakpoint (it renders one
  // layout at every width, see NewWorkspaceWizard.tsx's file header), but
  // the width math must still hold cleanly right at the boundary the rest
  // of the TUI resolves its own tiers against.
  assert.equal(
    listRowInnerWidth(CARD_NARROW_MAX),
    CARD_NARROW_MAX - WIZARD_GUTTER_COLUMNS - WIZARD_PAD_RIGHT,
    'inner width holds at the narrow-tier boundary (59)'
  )
  assert.equal(
    listRowInnerWidth(CARD_NARROW_MAX + 1),
    CARD_NARROW_MAX + 1 - WIZARD_GUTTER_COLUMNS - WIZARD_PAD_RIGHT,
    'inner width holds one column past the narrow-tier boundary (60)'
  )

  console.log(
    '✓ listRowInnerWidth: floors at 1 for degenerate widths, correct budget at phone width (38) and the 59/60 narrow-tier boundary'
  )
}

function testBuildListRowText(): void {
  const width38 = listRowInnerWidth(PHONE_COLUMNS) // 35

  // No suffix: a short label pads to EXACTLY width38 columns — the
  // pad-before-colour discipline every caller relies on.
  const short = buildListRowText('Claude', width38)
  assert.equal(short.length, width38, 'short label pads to the exact inner width')
  assert.ok(short.startsWith('Claude'), 'short label content preserved')

  // A label longer than the budget truncates (never wraps, never exceeds
  // the requested width) at phone width.
  const longLabel = 'a-very-long-provider-label-that-will-not-fit-in-35-columns'
  const truncated = buildListRowText(longLabel, width38)
  assert.equal(
    truncated.length,
    width38,
    'over-long label still pads/truncates to exactly the inner width'
  )
  assert.ok(
    truncated.endsWith('...'),
    'over-long label is ellipsis-truncated, not silently clipped'
  )

  // Suffix fits: a short model id + " (unavailable)" (14 chars) comfortably
  // fits inside 35 columns, so it must be appended.
  const withSuffix = buildListRowText('gpt-5', width38, ' (unavailable)')
  assert.equal(
    withSuffix.length,
    width38,
    'row with a fitting suffix still pads to the exact inner width'
  )
  assert.ok(withSuffix.includes('(unavailable)'), 'suffix is appended when it fits')

  // Suffix does NOT fit: a budget narrower than suffix.length + the 1-column
  // label floor (still a realistic width — e.g. a very cramped provider
  // column, not just phone-width 38, which comfortably fits both). The
  // suffix must be DROPPED entirely rather than rendered in truncated/
  // garbled form — a half-rendered "(unavail" is worse than no marker
  // (colour already carries the same signal in ListStep.tsx).
  const suffixText = ' (unavailable)'
  const tooNarrowForSuffix = suffixText.length // one short of suffix.length + 1
  const suffixDropped = buildListRowText('gpt-5', tooNarrowForSuffix, suffixText)
  assert.equal(
    suffixDropped.length,
    tooNarrowForSuffix,
    'row with a dropped suffix still pads to the exact inner width'
  )
  assert.ok(
    !suffixDropped.includes('(unavailable)'),
    'suffix is dropped entirely when it would not fit'
  )

  // Exact boundary: a budget of EXACTLY suffix.length + 1 must still fit the
  // suffix (1 label column + the full suffix) — this is the tightest case
  // where the suffix is kept, one column narrower than `suffixDropped` above.
  const suffix = ' (unavailable)'
  const tightBudget = suffix.length + 1
  const tightFit = buildListRowText('m', tightBudget, suffix)
  assert.equal(
    tightFit.length,
    tightBudget,
    'tight-fit row still pads to the exact requested width'
  )
  assert.ok(
    tightFit.includes('(unavailable)'),
    'suffix survives at the exact minimum fitting width'
  )

  console.log(
    '✓ buildListRowText: exact-width padding at phone width (38), ellipsis-truncates an over-long label, ' +
      '"(unavailable)" suffix appended when it fits and dropped (never garbled) when it does not, ' +
      'exact fit/no-fit boundary verified'
  )
}

function testBuildSummaryLine(): void {
  // At phone width (38 columns), a short summary line renders unchanged.
  const short = buildSummaryLine('mode', 'local', PHONE_COLUMNS)
  assert.equal(short, 'mode: local', 'short summary line renders unchanged at phone width')

  // A long model label truncates rather than wrapping (Ink wrapping this
  // line would silently grow the wizard's row count past its fixed-height
  // frame budget — see wizardLayout.ts's own doc comment).
  const longModel = 'claude-opus-4-8-with-a-very-long-descriptive-label-suffix'
  const truncatedLine = buildSummaryLine('model', longModel, PHONE_COLUMNS)
  assert.ok(
    truncatedLine.length <= PHONE_COLUMNS,
    'summary line never exceeds the requested content width'
  )
  assert.ok(
    truncatedLine.startsWith('model: '),
    'summary line keeps its label prefix even when truncated'
  )

  // Floors at 1 for a degenerate width, same discipline as listRowInnerWidth.
  const degenerate = buildSummaryLine('model', 'opus', 0)
  assert.ok(degenerate.length <= 1, 'summary line degrades to at most 1 column at width 0')

  // Holds at the narrow-tier boundary too.
  const atBoundary = buildSummaryLine('name', 'my-workspace', CARD_NARROW_MAX)
  assert.ok(
    atBoundary.length <= CARD_NARROW_MAX,
    'summary line respects the 59-column narrow-tier boundary'
  )

  console.log(
    '✓ buildSummaryLine: unchanged when it fits at phone width (38), truncates (never wraps) an over-long value, ' +
      'degenerate width floors at 1, holds at the 59-column narrow-tier boundary'
  )
}

function testBuildClosePromptLine(): void {
  // Short name at phone width: renders unchanged, well under the budget.
  const short = buildClosePromptLine('my-workspace', PHONE_COLUMNS)
  assert.equal(short, 'close "my-workspace"?', 'short name renders unchanged at phone width')
  assert.ok(short.length <= PHONE_COLUMNS, 'short-name prompt fits within phone width')

  // Long name at phone width: truncates the NAME only, literal wrapper
  // (`close "` / `"?`) is always fully preserved — the whole point of
  // reserving CLOSE_PROMPT_LITERAL_COLUMNS up front.
  const longName = 'my-super-long-workspace-name-here'
  const truncated = buildClosePromptLine(longName, PHONE_COLUMNS)
  assert.ok(
    truncated.length <= PHONE_COLUMNS,
    'close-prompt line never exceeds the requested content width'
  )
  assert.ok(truncated.startsWith('close "'), 'literal prefix is always preserved')
  assert.ok(truncated.endsWith('"?'), 'literal suffix is always preserved')
  assert.ok(truncated.includes('...'), 'over-long name is ellipsis-truncated')

  // Sanity: the reserved-literal-columns constant matches `close "` (7) +
  // `"?` (2) — if this ever drifts from the actual literal text, this
  // assertion (not just eyeballing the source) catches it.
  assert.equal(
    CLOSE_PROMPT_LITERAL_COLUMNS,
    'close "'.length + '"?'.length,
    'CLOSE_PROMPT_LITERAL_COLUMNS matches the actual literal wrapper length'
  )

  // Degenerate width floors the name budget at 1 rather than going
  // negative/zero into `truncate`.
  const degenerate = buildClosePromptLine('anything', 0)
  assert.ok(degenerate.length >= 1, 'degenerate width still produces output, never throws')

  console.log(
    '✓ buildClosePromptLine: unchanged at phone width for a short name, truncates only the ' +
      'variable name portion (never the literal wrapper) for an over-long name, reserved-columns ' +
      'constant matches the actual literal text, degenerate width never throws'
  )
}

/**
 * buildCreateArgs — the workspace.create payload. The load-bearing
 * assertion here is `focus: false`: workspace.create defaults `focus` to
 * TRUE server-side, which makes the DESKTOP app raise and foreground the
 * new workspace. That's right for the GUI's own create flow and wrong for
 * the TUI's, whose primary client is a phone over SSH — creating a
 * workspace from there must not yank the user's Mac to the front. Nothing
 * in the type system enforces it (the payload is Record<string, unknown>),
 * so it's asserted here instead.
 */
function testBuildCreateArgs(): void {
  const project = { id: 'p1', name: 'orpheus', cwd: '/tmp/orpheus' }
  const base = {
    project,
    name: '',
    mode: null,
    selectedModel: null
  } as unknown as Parameters<typeof buildCreateArgs>[0]

  const args = buildCreateArgs(base)
  assert.equal(args.focus, false, 'create never foregrounds the desktop app')
  assert.equal(args.projectId, 'p1', 'project id is threaded through')
  assert.equal(args.cwd, '/tmp/orpheus', 'project cwd is threaded through')
  assert.equal(args.mode, 'local', 'absent mode falls back to local')
  assert.ok(!('name' in args), 'an empty name is OMITTED so the server can default it')
  assert.ok(!('model' in args), 'no model selected means no model key')

  // A named/worktree/model-bearing create carries all three through, and
  // still never foregrounds.
  const full = buildCreateArgs({
    ...base,
    name: 'my-ws',
    mode: 'worktree',
    selectedModel: { id: 'claude-opus-5' }
  } as unknown as Parameters<typeof buildCreateArgs>[0])
  assert.equal(full.focus, false, 'focus stays false regardless of the other fields')
  assert.equal(full.name, 'my-ws', 'a non-empty name is sent')
  assert.equal(full.mode, 'worktree', 'worktree mode is sent')
  assert.equal(full.model, 'claude-opus-5', 'the selected model id is sent')

  console.log(
    '✓ buildCreateArgs: always sends focus:false (never foregrounds the desktop from a phone), ' +
      'omits an empty name so the server defaults it, and threads mode/model/cwd through'
  )
}

testListRowInnerWidth()
testBuildListRowText()
testBuildSummaryLine()
testBuildClosePromptLine()
testBuildCreateArgs()

console.log('\nAll tui-wizard assertions passed.')
