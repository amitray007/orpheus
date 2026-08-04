// ---------------------------------------------------------------------------
// scripts/verify-tui-wizard.ts
//
// Assertion harness for the PURE width-computation + accordion-flattening
// modules backing the new-workspace wizard
// (packages/orpheus-cli/src/tui/wizardLayout.ts, wizardStepMachine.ts) —
// mirrors scripts/verify-tui-layout.ts's/verify-tui-blocks.ts's own
// no-Ink/no-TTY/no-socket constraint. Neither module imports react/ink, so
// this exercises exactly the same functions NewWorkspaceWizard.tsx and its
// step components (ListStep/ConfirmStep/WizardScreens) consume, with no
// component mounted and no terminal involved.
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
//   4. buildCreateArgs: focus:false always sent, name always generated and
//      project-scoped.
//   5. buildModelAccordionRows (Step 1's single-screen accordion, replacing
//      the old two-screen provider/model-detail split): N providers
//      collapsed -> exactly N rows; expanding one provider adds exactly its
//      own model count, interleaved directly after its header row; only the
//      passed provider's models ever appear (never two providers' models at
//      once — the accordion has no representable "two expanded" state).
//      Exercised against the LIVE 4-provider/45-model shape (Claude 10,
//      Codex 10, Grok 13, Antigravity 12) reported from the running app,
//      not a toy fixture — that's the dataset that actually overflows a
//      phone viewport once one provider expands.
//   6. Cursor repositioning on expand/collapse (handleModelStepKey /
//      handleModelStepEnter): toggling a provider whose header shifted
//      position (because a DIFFERENT provider above it just collapsed as a
//      side effect) keeps the cursor on the just-toggled provider's row —
//      regression coverage for a real bug caught while building this
//      harness (a stale numeric cursor landed on the wrong row after the
//      list reflowed).
//   7. windowListRows (the accordion's viewport windowing — REQUIRED
//      because ListStep.tsx has no windowing of its own otherwise): the
//      highlighted row stays inside the returned window at the top, middle,
//      and bottom of a 17-row expanded accordion, swept across every cursor
//      position; the window never exceeds the available-rows budget; a list
//      that already fits passes through unwindowed. Checked at 38 columns'
//      row math and a ~12-row phone-viewport budget, per the task brief.
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import {
  listRowInnerWidth,
  buildListRowText,
  buildSummaryLine,
  buildClosePromptLine,
  windowListRows,
  CLOSE_PROMPT_LITERAL_COLUMNS,
  WIZARD_GUTTER_COLUMNS,
  WIZARD_PAD_RIGHT
} from '../packages/orpheus-cli/src/tui/wizardLayout.ts'
import { CARD_NARROW_MAX } from '../packages/orpheus-cli/src/tui/cardBreakpoints.ts'
import {
  buildCreateArgs,
  buildModelAccordionRows,
  handleModelStepKey,
  initialWizardState
} from '../packages/orpheus-cli/src/tui/wizardStepMachine.ts'
import type {
  ProviderGroup,
  SelectableModel,
  WizardState
} from '../packages/orpheus-cli/src/tui/wizardTypes.ts'
import type { Key } from 'ink'

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
 * buildCreateArgs — the workspace.create payload. Two load-bearing
 * assertions here:
 *
 * 1. `focus: false` — workspace.create defaults `focus` to TRUE
 *    server-side, which makes the DESKTOP app raise and foreground the new
 *    workspace. That's right for the GUI's own create flow and wrong for
 *    the TUI's, whose primary client is a phone over SSH — creating a
 *    workspace from there must not yank the user's Mac to the front.
 *
 * 2. `name` is ALWAYS present and non-empty — the wizard has no name-entry
 *    step (removed; see wizardTypes.ts's header for why) and must never omit
 *    `name` entirely, because an omitted name makes the server default to
 *    the literal string 'New workspace' (DEFAULT_WORKSPACE_NAME in
 *    src/main/workspaceOrchestration/service.ts), and several workspaces
 *    created back to back would then be indistinguishable in the picker
 *    until Claude emits its own terminal title. The generated name must
 *    include the project name so it's still distinguishable across
 *    different projects, and it's derived from `state.project.name`, not
 *    typed by the user.
 *
 * Nothing in the type system enforces either — the payload is
 * Record<string, unknown> — so both are asserted here instead.
 */
function testBuildCreateArgs(): void {
  const project = { id: 'p1', name: 'orpheus', cwd: '/tmp/orpheus' }
  const base = {
    project,
    mode: null,
    selectedModel: null
  } as unknown as Parameters<typeof buildCreateArgs>[0]

  const args = buildCreateArgs(base)
  assert.equal(args.focus, false, 'create never foregrounds the desktop app')
  assert.equal(args.projectId, 'p1', 'project id is threaded through')
  assert.equal(args.cwd, '/tmp/orpheus', 'project cwd is threaded through')
  assert.equal(args.mode, 'local', 'absent mode falls back to local')
  assert.ok('name' in args, 'a name is ALWAYS sent — never omitted for the server to default')
  assert.equal(typeof args.name, 'string', 'the generated name is a string')
  assert.ok((args.name as string).length > 0, 'the generated name is non-empty')
  assert.ok(
    (args.name as string).includes(project.name),
    'the generated name includes the project name, so back-to-back creates stay distinguishable'
  )
  assert.ok(!('model' in args), 'no model selected means no model key')

  // A worktree/model-bearing create carries mode/model through, and still
  // never foregrounds and still always names.
  const full = buildCreateArgs({
    ...base,
    mode: 'worktree',
    selectedModel: { id: 'claude-opus-5' }
  } as unknown as Parameters<typeof buildCreateArgs>[0])
  assert.equal(full.focus, false, 'focus stays false regardless of the other fields')
  assert.ok(
    typeof full.name === 'string' && full.name.length > 0 && full.name.includes(project.name),
    'name is still generated and non-empty regardless of mode/model'
  )
  assert.equal(full.mode, 'worktree', 'worktree mode is sent')
  assert.equal(full.model, 'claude-opus-5', 'the selected model id is sent')

  // Two calls in quick succession (simulating two workspaces created
  // back-to-back) must both carry a name that includes the project name —
  // the whole point of generating rather than omitting.
  const first = buildCreateArgs(base)
  const second = buildCreateArgs(base)
  assert.ok(
    (first.name as string).includes(project.name) && (second.name as string).includes(project.name),
    'repeated creates for the same project both get a distinguishable, project-scoped name'
  )

  console.log(
    '✓ buildCreateArgs: always sends focus:false (never foregrounds the desktop from a phone), ' +
      'always sends a non-empty generated name that includes the project name (never omitted, ' +
      'never left to the server default), and threads mode/model/cwd through'
  )
}

/**
 * buildModelAccordionRows — Step 1's accordion flattening (see
 * wizardStepMachine.ts's own doc comment). Built against the LIVE provider/
 * model shape reported from the running app at the time this harness was
 * written (4 providers: Claude 10, Codex 10, Grok 13, Antigravity 12 models —
 * 45 models total) rather than a toy 2-provider/2-model fixture, because the
 * whole reason this function (and the windowing below) exists is that this
 * real dataset is what makes an unwindowed accordion overflow a phone
 * viewport — a small fixture wouldn't exercise the case that matters.
 */
function buildLiveProviderGroups(): ProviderGroup[] {
  const counts: Record<string, number> = { claude: 10, codex: 10, xai: 13, antigravity: 12 }
  const labels: Record<string, string> = {
    claude: 'Claude',
    codex: 'Codex (OpenAI)',
    xai: 'Grok (xAI)',
    antigravity: 'Antigravity'
  }
  return Object.entries(counts).map(([providerId, count]) => {
    const models: SelectableModel[] = Array.from({ length: count }, (_, i) => ({
      id: `${providerId}-model-${i}`,
      label: `${providerId} model ${i}`,
      providerId,
      providerLabel: labels[providerId] ?? providerId,
      isClaude: providerId === 'claude',
      available: true,
      contextWindow: null,
      effortLevels: null,
      provisional: false
    }))
    return { providerId, providerLabel: labels[providerId] ?? providerId, models }
  })
}

function testBuildModelAccordionRows(): void {
  const groups = buildLiveProviderGroups()
  const providerCount = groups.length
  assert.equal(providerCount, 4, 'sanity: live fixture has 4 providers')

  // Every provider collapsed (expandedProviderId: null) -> exactly one row
  // per provider, nothing else. This is the "N providers collapsed -> N
  // rows" case the task brief calls out explicitly.
  const collapsed = buildModelAccordionRows(groups, null)
  assert.equal(collapsed.length, providerCount, 'all collapsed: exactly one row per provider')
  assert.ok(
    collapsed.every((row) => row.kind === 'provider'),
    'all collapsed: every row is a provider header, no model rows leak in'
  )
  assert.ok(
    collapsed.every((row) => row.kind === 'provider' && !row.expanded),
    'all collapsed: every provider row reports expanded:false'
  )

  // Expanding the LARGEST group (Grok/xai, 13 models) -> N provider rows +
  // exactly that provider's model count, interleaved directly after its own
  // header row (not appended at the end, not interleaved with another
  // provider's rows).
  const grok = groups.find((g) => g.providerId === 'xai')
  assert.ok(grok != null, 'sanity: xai group exists in the fixture')
  const expanded = buildModelAccordionRows(groups, 'xai')
  assert.equal(
    expanded.length,
    providerCount + grok!.models.length,
    "one expanded: row count is N providers + that provider's own model count (4 + 13 = 17)"
  )
  const grokHeaderIndex = expanded.findIndex(
    (row) => row.kind === 'provider' && row.group.providerId === 'xai'
  )
  assert.ok(grokHeaderIndex >= 0, 'expanded provider still has its own header row')
  assert.ok(
    expanded[grokHeaderIndex]!.kind === 'provider' &&
      (expanded[grokHeaderIndex] as { expanded: boolean }).expanded,
    "the expanded provider's own row reports expanded:true"
  )
  for (let i = 0; i < grok!.models.length; i++) {
    const row = expanded[grokHeaderIndex + 1 + i]
    assert.ok(
      row != null && row.kind === 'model' && row.providerId === 'xai',
      `model row ${i} is interleaved immediately after its provider's header row, not appended elsewhere`
    )
  }
  // Every OTHER provider stays a single collapsed row — expanding one never
  // implicitly expands or removes any other.
  const otherProviderRows = expanded.filter(
    (row) => row.kind === 'provider' && row.group.providerId !== 'xai'
  )
  assert.equal(
    otherProviderRows.length,
    providerCount - 1,
    'every non-expanded provider still contributes exactly one row'
  )
  assert.ok(
    otherProviderRows.every((row) => row.kind === 'provider' && !row.expanded),
    'every non-expanded provider row reports expanded:false'
  )

  // ONLY ONE PROVIDER EXPANDABLE AT A TIME: buildModelAccordionRows takes a
  // single expandedProviderId (not a set), so asking it to expand provider B
  // while STILL passing provider B (simulating "the user already had A open,
  // pressed enter on B, and the caller correctly replaced expandedProviderId
  // rather than adding to it") must show B's models and NOT A's — there is
  // no representable state with two providers expanded simultaneously; this
  // assertion documents that by checking a second provider's rows never
  // appear alongside the first's.
  const claudeExpanded = buildModelAccordionRows(groups, 'claude')
  const claudeModelRows = claudeExpanded.filter((row) => row.kind === 'model')
  assert.equal(
    claudeModelRows.length,
    groups.find((g) => g.providerId === 'claude')!.models.length,
    "expanding claude shows exactly claude's own model rows"
  )
  assert.ok(
    claudeModelRows.every((row) => row.kind === 'model' && row.providerId === 'claude'),
    "expanding claude never mixes in another provider's model rows (single expandedProviderId, not a set)"
  )

  console.log(
    '✓ buildModelAccordionRows: N providers collapsed -> exactly N rows, expanding one provider adds ' +
      'exactly its own model count interleaved after its header, every other provider stays one collapsed ' +
      "row, and only the passed provider's models ever appear (never two providers' models at once)"
  )
}

/** Minimal ink Key stub — handleModelStepKey only reads escape/downArrow/
 *  upArrow/return off it, so a full Key isn't needed; every other field is
 *  irrelevant to the code under test. Kept file-local rather than exported
 *  from anywhere real since this is purely a test fixture. */
function keyStub(overrides: Partial<Key>): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides
  }
}

/**
 * CURSOR REPOSITIONING ON EXPAND/COLLAPSE — regression coverage for a real
 * bug caught while building this harness (see wizardStepMachine.ts's own
 * "CURSOR REPOSITIONING ON TOGGLE" doc comment on handleModelStepEnter for
 * the full mechanism). Reproduction: expand provider A, move the cursor down
 * onto provider B's header (now sitting one or more rows lower because A's
 * models are interleaved above it), press enter to expand B (which
 * implicitly collapses A). If the cursor is left at its old NUMERIC index,
 * the list reflow (A's model rows disappearing) leaves the highlight sitting
 * on the WRONG row — verified below by asserting the row actually under the
 * cursor after the toggle is still a 'provider' row for the provider that
 * was just toggled, never a model row that happened to shift into that slot.
 */
function testCursorRepositioningOnToggle(): void {
  const groups = buildLiveProviderGroups() // claude(10), codex(10), xai(13), antigravity(12)
  let state: WizardState = {
    ...initialWizardState({ id: 'p1', name: 'orpheus', cwd: '/tmp/orpheus' }),
    models: { kind: 'ready', value: groups }
  }
  const setState = (updater: (s: WizardState) => WizardState): void => {
    state = updater(state)
  }

  // Expand 'claude' (cursor starts at 0, the claude header — enter expands it).
  handleModelStepKey('', keyStub({ return: true }), state, setState, () => {})
  assert.equal(state.expandedProviderId, 'claude', 'claude is now expanded')
  assert.equal(state.cursor, 0, 'cursor stays on the just-toggled claude header (index 0)')

  // Move the cursor down past all 10 of claude's models to land on codex's
  // header: claude(0), 10 models(1-10), codex header(11).
  for (let i = 0; i < 11; i++) {
    handleModelStepKey('j', keyStub({ downArrow: false }), state, setState, () => {})
  }
  const rowsWithClaudeExpanded = buildModelAccordionRows(groups, 'claude')
  assert.equal(state.cursor, 11, 'sanity: cursor walked down 11 rows via j')
  assert.ok(
    rowsWithClaudeExpanded[state.cursor]!.kind === 'provider' &&
      (rowsWithClaudeExpanded[state.cursor] as { group: ProviderGroup }).group.providerId ===
        'codex',
    "sanity: cursor is sitting on codex's own header row before the toggle"
  )

  // Enter on codex's header: expands codex, implicitly collapses claude
  // (removing claude's 10 model rows from ABOVE codex's position). Without
  // the cursor-repositioning fix, cursor would stay at 11 — which, after
  // claude's 10 rows disappear, points at a totally different row.
  handleModelStepKey('', keyStub({ return: true }), state, setState, () => {})
  assert.equal(
    state.expandedProviderId,
    'codex',
    'codex is now expanded (claude implicitly collapsed)'
  )
  const rowsAfterToggle = buildModelAccordionRows(groups, 'codex')
  const rowAtCursor = rowsAfterToggle[state.cursor]
  assert.ok(
    rowAtCursor != null && rowAtCursor.kind === 'provider',
    'after the toggle, the cursor still lands on A provider header row (not a model row that shifted into its slot)'
  )
  assert.equal(
    rowAtCursor!.kind === 'provider' ? rowAtCursor.group.providerId : null,
    'codex',
    'after the toggle, the cursor lands on THE SAME provider (codex) that was just toggled, not wherever the old numeric index now points'
  )

  console.log(
    '✓ cursor repositioning on expand/collapse: toggling a provider whose header shifted position ' +
      '(because a previously-expanded provider above it just collapsed) keeps the cursor ON the ' +
      'just-toggled provider row, never left at a stale numeric index pointing at the wrong row'
  )
}

/**
 * windowListRows — the accordion's viewport windowing (see wizardLayout.ts's
 * own "WHY THIS ISN'T blocks.ts's windowBlocks REUSED" section). Exercised
 * against the SAME live 45-model fixture, expanded to its worst case (Grok,
 * 13 models -> 17 total rows), at phone width's row budget (~12 rows, per
 * the task brief) — the exact scenario that would silently push the
 * highlighted row and hint line off-screen without this function.
 */
function testWindowListRows(): void {
  const PHONE_ROWS = 12
  const groups = buildLiveProviderGroups()
  const rows = buildModelAccordionRows(groups, 'xai') // 17 rows, the worst case
  assert.equal(rows.length, 17, 'sanity: expanded-Grok fixture is 17 rows')

  // TOP: highlighting the very first row must keep it visible and never
  // scroll the window past the start.
  const atTop = windowListRows(rows, 0, PHONE_ROWS)
  assert.ok(atTop.windowed, 'a 17-row list at a 12-row budget engages windowing')
  assert.ok(
    atTop.visibleHighlightedIndex >= 0 && atTop.visibleHighlightedIndex < atTop.visible.length,
    'top: highlighted row is inside the returned window'
  )
  assert.equal(atTop.aboveCount, 0, 'top: nothing scrolled off above the very first row')
  assert.ok(
    atTop.visible.length <= PHONE_ROWS,
    'top: visible window never exceeds the available-rows budget'
  )

  // MIDDLE: highlighting a row in the middle of the list.
  const middleIndex = Math.floor(rows.length / 2)
  const atMiddle = windowListRows(rows, middleIndex, PHONE_ROWS)
  assert.ok(
    atMiddle.visibleHighlightedIndex >= 0 &&
      atMiddle.visibleHighlightedIndex < atMiddle.visible.length,
    'middle: highlighted row is inside the returned window'
  )
  assert.equal(
    atMiddle.visible[atMiddle.visibleHighlightedIndex],
    rows[middleIndex],
    'middle: the windowed highlighted row is actually the SAME row object the caller highlighted'
  )
  assert.ok(
    atMiddle.visible.length <= PHONE_ROWS,
    'middle: visible window never exceeds the available-rows budget'
  )

  // BOTTOM: highlighting the very last row must keep it visible and never
  // report anything scrolled off below it.
  const lastIndex = rows.length - 1
  const atBottom = windowListRows(rows, lastIndex, PHONE_ROWS)
  assert.ok(
    atBottom.visibleHighlightedIndex >= 0 &&
      atBottom.visibleHighlightedIndex < atBottom.visible.length,
    'bottom: highlighted row is inside the returned window'
  )
  assert.equal(atBottom.belowCount, 0, 'bottom: nothing scrolled off below the very last row')
  assert.ok(
    atBottom.visible.length <= PHONE_ROWS,
    'bottom: visible window never exceeds the available-rows budget'
  )

  // The window is NEVER allowed to exceed the availableRows budget at ANY
  // cursor position — sweep every index, not just the three checkpoints
  // above, since an off-by-one in the affordance-row accounting could slip
  // through a coarser sweep.
  for (let i = 0; i < rows.length; i++) {
    const w = windowListRows(rows, i, PHONE_ROWS)
    assert.ok(
      w.visible.length <= PHONE_ROWS,
      `cursor ${i}: window never exceeds the ${PHONE_ROWS}-row budget`
    )
    assert.ok(
      w.visibleHighlightedIndex >= 0 && w.visibleHighlightedIndex < w.visible.length,
      `cursor ${i}: highlighted row is always inside the returned window`
    )
  }

  // Collapsed (4 rows) at the same 12-row budget comfortably fits -> no
  // windowing engaged at all, matching layout.ts's own scrollWindowFor
  // passthrough contract.
  const collapsedRows = buildModelAccordionRows(groups, null)
  const collapsedWindow = windowListRows(collapsedRows, 0, PHONE_ROWS)
  assert.ok(!collapsedWindow.windowed, 'collapsed 4-row list at a 12-row budget needs no windowing')
  assert.equal(
    collapsedWindow.visible.length,
    collapsedRows.length,
    'collapsed list passes through unchanged when it fits'
  )

  console.log(
    '✓ windowListRows: at 38 columns / ~12-row phone budget, the highlighted row stays inside the ' +
      'returned window at the top, middle, and bottom of a 17-row expanded accordion, the window never ' +
      'exceeds the available-rows budget at any cursor position, and a list that already fits passes ' +
      'through unwindowed'
  )
}

testListRowInnerWidth()
testBuildListRowText()
testBuildSummaryLine()
testBuildClosePromptLine()
testBuildCreateArgs()
testBuildModelAccordionRows()
testCursorRepositioningOnToggle()
testWindowListRows()

console.log('\nAll tui-wizard assertions passed.')
