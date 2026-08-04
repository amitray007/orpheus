// ---------------------------------------------------------------------------
// scripts/verify-tui-wizard.ts
//
// Assertion harness for the PURE width-computation + model-list-flattening
// modules backing the new-workspace wizard
// (packages/orpheus-cli/src/tui/wizardLayout.ts, wizardStepMachine.ts) —
// mirrors scripts/verify-tui-layout.ts's/verify-tui-blocks.ts's own
// no-Ink/no-TTY/no-socket constraint. Neither module imports react/ink, so
// this exercises exactly the same functions NewWorkspaceWizard.tsx and its
// step components (ListStep/WizardScreens) consume, with no component
// mounted and no terminal involved.
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
//   3. buildSummaryLine: truncates a "label: value" line (used by
//      CloseArchiveConfirm.tsx) to the given content width, at 38 columns
//      and at 59/60.
//   4. buildCreateArgs: focus:false always sent, name always generated and
//      project-scoped.
//   5. buildModelListRows (Step 1's single, ALWAYS FULLY EXPANDED screen —
//      replacing the old accordion where one provider expanded at a time):
//      every provider contributes exactly one header row followed by every
//      one of its models, ALL providers, always — no collapsed state exists
//      any more. Exercised against the LIVE 4-provider/45-model shape
//      (Claude 10, Codex 10, Grok 13, Antigravity 12) reported from the
//      running app, not a toy fixture — that's the dataset that actually
//      overflows a phone viewport once every provider is shown at once.
//   6. moveModelCursor: the cursor SKIPS provider headers and unavailable
//      models — moving down from the last model of one group lands on the
//      first AVAILABLE model of the next, never on a header or a disabled
//      row; clamps (doesn't wrap) at either end.
//   7. windowListRows (the model list's viewport windowing — REQUIRED
//      because ListStep.tsx has no windowing of its own otherwise): the
//      highlighted row stays inside the returned window at the top, middle,
//      and bottom of a ~49-row fully-expanded list, swept across every
//      cursor position; the window never exceeds the available-rows budget;
//      a list that already fits passes through unwindowed. Checked at 38
//      columns' row math and a ~12-row phone-viewport budget, per the task
//      brief.
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
  buildModelListRows,
  firstSelectableModelIndex,
  moveModelCursor
} from '../packages/orpheus-cli/src/tui/wizardStepMachine.ts'
import type { ProviderGroup, SelectableModel } from '../packages/orpheus-cli/src/tui/wizardTypes.ts'

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

  // A long value truncates rather than wrapping (Ink wrapping this line
  // would silently grow a fixed-height screen's row count past its budget —
  // see wizardLayout.ts's own doc comment).
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
 * These assertions are UNCHANGED by removing the confirm step: buildCreateArgs
 * itself didn't move or change shape, only WHEN it's called did (immediately
 * on mode/model selection instead of from a dedicated confirm screen — see
 * NewWorkspaceWizard.tsx's `submit`).
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
      'never left to the server default), and threads mode/model/cwd through — unchanged by the ' +
      'confirm-step removal'
  )
}

/**
 * buildModelListRows — Step 1's flattening, now that every provider is
 * ALWAYS fully expanded (see wizardStepMachine.ts's own doc comment). Built
 * against the LIVE provider/model shape reported from the running app at the
 * time this harness was written (4 providers: Claude 10, Codex 10, Grok 13,
 * Antigravity 12 models — 45 models total) rather than a toy 2-provider/
 * 2-model fixture, because the whole reason this function (and the
 * windowing below) exists is that this real dataset is what makes an
 * unwindowed, fully-expanded list overflow a phone viewport — a small
 * fixture wouldn't exercise the case that matters.
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

/**
 * Same live shape, but with one model per provider marked unavailable
 * (`available: false`) — used by `testMoveModelCursor` to prove the cursor
 * skips those too, not just headers. Kept as a separate builder (rather than
 * mutating `buildLiveProviderGroups`'s output in place per test) so every
 * OTHER test keeps working against an all-available fixture without needing
 * to know or care about this one's unavailable-row wrinkle.
 */
function buildLiveProviderGroupsWithUnavailable(): ProviderGroup[] {
  const groups = buildLiveProviderGroups()
  return groups.map((group) => ({
    ...group,
    // Mark the SECOND model of each group unavailable (index 1) — not the
    // first, so a "skips the first row of a group" bug can't hide behind a
    // "starts navigation past index 0 anyway" coincidence.
    models: group.models.map((model, i) => (i === 1 ? { ...model, available: false } : model))
  }))
}

function testBuildModelListRows(): void {
  const groups = buildLiveProviderGroups()
  const providerCount = groups.length
  const totalModels = groups.reduce((sum, g) => sum + g.models.length, 0)
  assert.equal(providerCount, 4, 'sanity: live fixture has 4 providers')
  assert.equal(totalModels, 45, 'sanity: live fixture has 45 models total')

  const rows = buildModelListRows(groups)
  assert.equal(
    rows.length,
    providerCount + totalModels,
    'every provider header + every one of its models, all providers, always (4 headers + 45 models = 49 rows)'
  )

  const headerRows = rows.filter((row) => row.kind === 'provider')
  assert.equal(
    headerRows.length,
    providerCount,
    'exactly one header row per provider, no collapsing'
  )
  assert.deepEqual(
    headerRows.map((row) => (row.kind === 'provider' ? row.group.providerId : null)),
    groups.map((g) => g.providerId),
    'header rows appear in the same order as the provider groups, one each'
  )

  // Every provider's models are interleaved directly after its own header
  // row (not appended at the end, not interleaved with another provider's
  // rows) — this is the "always fully expanded" contract every screen
  // relies on: there is no collapsed state to accidentally reintroduce.
  let cursor = 0
  for (const group of groups) {
    const headerRow = rows[cursor]
    assert.ok(
      headerRow != null &&
        headerRow.kind === 'provider' &&
        headerRow.group.providerId === group.providerId,
      `row ${cursor} is ${group.providerId}'s own header row, not another provider's or a model`
    )
    cursor++
    for (let i = 0; i < group.models.length; i++) {
      const modelRow = rows[cursor]
      assert.ok(
        modelRow != null && modelRow.kind === 'model' && modelRow.providerId === group.providerId,
        `row ${cursor} is one of ${group.providerId}'s own models, interleaved immediately after its header`
      )
      cursor++
    }
  }
  assert.equal(cursor, rows.length, 'walked every row exactly once: no gaps, no leftovers')

  console.log(
    '✓ buildModelListRows: every provider contributes exactly one header row followed by every one of ' +
      "its models — ALL 4 providers, all 45 models, always (no collapsed state exists any more; there's " +
      'nothing to expand/collapse and no representable partial state)'
  )
}

/**
 * moveModelCursor — the cursor SKIPS provider headers and unavailable
 * models, so it only ever rests on a selectable model. This replaces the old
 * accordion's cursor-repositioning-on-toggle coverage: with nothing to
 * toggle any more (every provider is always expanded), that whole class of
 * bug (a stale numeric cursor landing on the wrong row after a reflow) is
 * gone — there is no reflow. What DOES need coverage now is the skip
 * behaviour itself, since `highlightedIndex` is no longer guaranteed to be
 * a model just because it's a valid array index.
 */
function testMoveModelCursor(): void {
  const groups = buildLiveProviderGroups()
  const rows = buildModelListRows(groups) // 49 rows: claude header+10, codex header+10, xai header+13, antigravity header+12

  // Starting at row 0 (claude's header, per buildModelListRows's own
  // ordering) and moving down must land on claude's FIRST model (row 1),
  // never staying on the header.
  const firstMove = moveModelCursor(rows, 0, 1)
  assert.equal(rows[firstMove]!.kind, 'model', 'moving down from row 0 (a header) lands on a model')
  assert.equal(
    rows[firstMove]!.kind === 'model' ? rows[firstMove]!.providerId : null,
    'claude',
    "moving down from claude's header lands on claude's own first model"
  )

  // Crossing a provider boundary: walk from claude's header down 10 models
  // (indices 1..10) to sit on claude's LAST model (index 10) — one more
  // step must land on codex's FIRST model (skipping codex's header row,
  // index 11), reading as if the header in between weren't there.
  let cursor = 0
  for (let i = 0; i < 10; i++) cursor = moveModelCursor(rows, cursor, 1)
  assert.ok(
    rows[cursor]!.kind === 'model' && rows[cursor]!.providerId === 'claude',
    "sanity: 10 down-moves from claude's header lands on claude's own last model"
  )
  const crossedBoundary = moveModelCursor(rows, cursor, 1)
  assert.ok(
    rows[crossedBoundary]!.kind === 'model' && rows[crossedBoundary]!.providerId === 'codex',
    "one more down-move crosses codex's header row entirely, landing directly on codex's first model"
  )

  // Moving UP from the very first selectable row (claude's first model)
  // clamps rather than wrapping to the list's end or landing on the header.
  const clampedUp = moveModelCursor(rows, firstMove, -1)
  assert.equal(
    clampedUp,
    firstMove,
    'moving up from the first selectable model clamps, does not wrap'
  )

  // Moving DOWN from the very last row (antigravity's last model) clamps.
  const lastModelIndex = rows.length - 1
  assert.equal(
    rows[lastModelIndex]!.kind,
    'model',
    "sanity: buildModelListRows's last row is a model (antigravity's), not a trailing header"
  )
  const clampedDown = moveModelCursor(rows, lastModelIndex, 1)
  assert.equal(
    clampedDown,
    lastModelIndex,
    'moving down from the last selectable model clamps, does not wrap'
  )

  // UNAVAILABLE MODELS ARE SKIPPED TOO — not just headers. Every group's
  // second model (index 1) is unavailable in this fixture; moving down from
  // each group's first model must skip straight to its third model (index
  // 2), never landing on the disabled row in between.
  const rowsWithUnavailable = buildModelListRows(buildLiveProviderGroupsWithUnavailable())
  const claudeFirstModel = moveModelCursor(rowsWithUnavailable, 0, 1) // claude's header -> first model
  assert.ok(
    rowsWithUnavailable[claudeFirstModel]!.kind === 'model' &&
      (rowsWithUnavailable[claudeFirstModel] as { model: SelectableModel }).model.available,
    "sanity: claude's first model is available in this fixture"
  )
  const skippedUnavailable = moveModelCursor(rowsWithUnavailable, claudeFirstModel, 1)
  assert.ok(
    rowsWithUnavailable[skippedUnavailable]!.kind === 'model' &&
      (rowsWithUnavailable[skippedUnavailable] as { model: SelectableModel }).model.available &&
      (rowsWithUnavailable[skippedUnavailable] as { model: SelectableModel }).model.id ===
        'claude-model-2',
    'moving down from an available model skips the very next (unavailable) row and lands on the next available one'
  )

  // firstSelectableModelIndex — used to seed the cursor once models.list
  // resolves (row 0 is always a header, never a valid starting cursor).
  const seed = firstSelectableModelIndex(rows)
  assert.ok(
    seed >= 0 && rows[seed]!.kind === 'model',
    'the seeded starting index always points at a model'
  )
  assert.equal(
    seed,
    1,
    "sanity: with every model available, the seed is row 1 (claude's first model)"
  )

  console.log(
    '✓ moveModelCursor: skips provider headers AND unavailable models — crossing a provider boundary lands ' +
      "on the next group's first AVAILABLE model as if the header (and any disabled rows) weren't there; " +
      'clamps (never wraps) at either end; firstSelectableModelIndex always seeds a model, never a header'
  )
}

/**
 * windowListRows — the model list's viewport windowing (see wizardLayout.ts's
 * own "WHY THIS ISN'T blocks.ts's windowBlocks REUSED" section). Exercised
 * against the SAME live 45-model fixture, always fully expanded (49 rows: 45
 * models + 4 headers), at phone width's row budget (~12 rows, per the task
 * brief) — the exact scenario that would silently push the highlighted row
 * and hint line off-screen without this function.
 */
function testWindowListRows(): void {
  const PHONE_ROWS = 12
  const groups = buildLiveProviderGroups()
  const rows = buildModelListRows(groups) // 49 rows, always fully expanded
  assert.equal(rows.length, 49, 'sanity: fully-expanded fixture is 49 rows (4 headers + 45 models)')

  // TOP: highlighting the very first row must keep it visible and never
  // scroll the window past the start.
  const atTop = windowListRows(rows, 0, PHONE_ROWS)
  assert.ok(atTop.windowed, 'a 49-row list at a 12-row budget engages windowing')
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

  // A short list (well under the row budget) passes through unwindowed —
  // matches layout.ts's own scrollWindowFor passthrough contract. (There is
  // no more "collapsed" state to build this from — a single provider's own
  // rows, e.g. claude's header + 10 models = 11 rows, stands in as the
  // "comfortably fits" case instead.)
  const shortRows = rows.slice(0, 11)
  const shortWindow = windowListRows(shortRows, 0, PHONE_ROWS)
  assert.ok(!shortWindow.windowed, 'an 11-row list at a 12-row budget needs no windowing')
  assert.equal(
    shortWindow.visible.length,
    shortRows.length,
    'a list that already fits passes through unchanged'
  )

  console.log(
    '✓ windowListRows: at 38 columns / ~12-row phone budget, the highlighted row stays inside the ' +
      'returned window at the top, middle, and bottom of a 49-row fully-expanded list, the window never ' +
      'exceeds the available-rows budget at any cursor position, and a list that already fits passes ' +
      'through unwindowed'
  )
}

testListRowInnerWidth()
testBuildListRowText()
testBuildSummaryLine()
testBuildClosePromptLine()
testBuildCreateArgs()
testBuildModelListRows()
testMoveModelCursor()
testWindowListRows()

console.log('\nAll tui-wizard assertions passed.')
