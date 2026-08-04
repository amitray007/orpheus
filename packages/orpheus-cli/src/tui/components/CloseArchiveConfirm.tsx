/**
 * tui/components/CloseArchiveConfirm.tsx — the compact confirm overlays for
 * `x` (close, reversible) and `X` (archive, PERMANENT DELETE) on the
 * currently-highlighted workspace row in the picker (App.tsx).
 *
 * ONE FILE, TWO MODES — not two files, per the task brief's "1 vs 2 files"
 * call: both overlays are the same shape (a compact box, a summary of what's
 * about to happen, a hint line, an inline async submit/error state) at a
 * scale (well under 200 lines total) where splitting them would just
 * duplicate the StatusLine/Box scaffolding. `mode` picks which copy/keys
 * apply; the async submit/error rendering is shared.
 *
 * WHY THIS IS NOT wizard/ConfirmStep.tsx VERBATIM
 * -----------------------------------------------------------------------
 * ConfirmStep.tsx is the wizard's full-screen step (replaces the ENTIRE
 * body). This is a small, non-full-screen overlay: the picker underneath
 * stays exactly as it is per the task brief ("does NOT need to be a
 * separate full-screen overlay like the wizard — it can be a compact box"),
 * so this component renders just the box, and App.tsx is responsible for
 * stacking it (below the title bar, above/instead of the footer — see
 * App.tsx's PickerScreen wiring). No `flexGrow`/no border — a plain
 * <Box flexDirection="column"> the same way ConfirmStep's own StatusLine
 * needs no background tint (see that file's header): simpler is enough
 * here, per the task brief's "if you don't need a background tint... a
 * plain <Text> block may be entirely sufficient" steer.
 *
 * ARCHIVE IS A TWO-KEY FLOW, NOT A TYPED-NAME CONFIRM
 * -----------------------------------------------------------------------
 * See CLOSE vs ARCHIVE STAGE below for the exact mechanics. Chosen over
 * typed-name confirmation for phone usability — see App.tsx's
 * handleCloseArchiveKey doc comment and the final task report for the full
 * reasoning; the short version: typing an exact workspace name on a phone
 * soft keyboard is real friction for a flow this codebase explicitly
 * designs around (see NewWorkspaceWizard.tsx's file header), while a
 * two-keystroke deliberate sequence (`X` opens the confirm, `d` executes)
 * is friction-free to type but still categorically un-triggerable by a
 * single keypress or a stuck/bouncing key repeating the SAME key.
 *
 * WIDTH DISCIPLINE — 38 COLUMNS, PLAIN ASCII, PAD-THEN-COLOR
 * -----------------------------------------------------------------------
 * Every line here is `wrap="truncate-end"`, and workspace names/branches are
 * truncated INTO their surrounding prompt text by `buildClosePromptLine()`/
 * `buildSummaryLine()` (wizardLayout.ts) rather than via a bare `truncate()`
 * call here — those helpers budget the literal wrapper text first, exactly
 * like wizardLayout.ts's own header describes, and live there (not
 * duplicated in this file) so scripts/verify-tui-wizard.ts can assert their
 * width math with no Ink/component involved. No `backgroundColor` is used
 * anywhere in this file, so the "pad THEN color" rule doesn't apply — see
 * the file header note above.
 */

import * as React from 'react'
import { Box, Text } from 'ink'
import { buildClosePromptLine, buildSummaryLine } from '../wizardLayout.js'
import type { Palette } from '../theme.js'

export type CloseArchiveMode = 'close' | 'archive'

/**
 * CLOSE vs ARCHIVE STAGE
 * -----------------------------------------------------------------------
 * 'close' has exactly one stage: a single lightweight confirm (`enter`
 * executes, `esc` cancels) — appropriate because workspace.close is
 * reversible via workspace.reopen.
 *
 * 'archive' has two stages, entered in order and never skippable:
 *   'confirm' — shown the instant `X` is pressed on a row. Explains the
 *     action is PERMANENT and removes the worktree, shows the workspace
 *     name (+ branch, if any). `d` advances to 'execute'; `esc` cancels
 *     the whole flow with no action taken.
 *   'execute' — a SEPARATE screen requiring a SEPARATE deliberate key
 *     (`enter`) to actually call workspace.archive. This is the "press a
 *     DIFFERENT key to execute" shape the task brief steers toward over a
 *     same-key double-press, which a stuck/bouncing `X` key could satisfy
 *     by accident. `esc` at this stage cancels back to the picker
 *     entirely (not back to 'confirm') — once you've already cleared the
 *     first speed bump, "esc = abort the whole thing" reads more honestly
 *     than making the user re-read the warning a second time.
 */
export type ArchiveStage = 'confirm' | 'execute'

export interface CloseArchiveConfirmProps {
  mode: CloseArchiveMode
  /** Only meaningful when mode === 'archive'; ignored for 'close'. */
  archiveStage: ArchiveStage
  workspaceName: string
  /** WorkspaceDisplayRow.worktreeBranch — shown only for archive, only when set. */
  worktreeBranch: string | null
  submitting: boolean
  submitError: string | null
  width: number
  palette: Palette
}

const BOX_WIDTH_FLOOR = 20

function StatusLine({
  submitting,
  submitError,
  palette
}: {
  submitting: boolean
  submitError: string | null
  palette: Palette
}): React.JSX.Element | null {
  if (submitting) {
    return (
      <Text color={palette.awaiting} wrap="truncate-end">
        working…
      </Text>
    )
  }
  if (submitError != null) {
    return (
      <Text color={palette.attention} wrap="truncate-end">
        {submitError}
      </Text>
    )
  }
  return null
}

/** Close: single-stage, lightweight — `close "name"?` plus the hint line. */
function CloseBody({
  workspaceName,
  width,
  palette
}: {
  workspaceName: string
  width: number
  palette: Palette
}): React.JSX.Element {
  const line = buildClosePromptLine(workspaceName, width)
  return (
    <>
      <Text bold color={palette.groupLabel} wrap="truncate-end">
        {line}
      </Text>
      <Box marginTop={1}>
        <Text color={palette.secondary} wrap="truncate-end">
          {'enter confirm   esc cancel'}
        </Text>
      </Box>
    </>
  )
}

/** Archive stage 1: the PERMANENT warning + name/branch + advance-to-execute hint. */
function ArchiveConfirmBody({
  workspaceName,
  worktreeBranch,
  width,
  palette
}: {
  workspaceName: string
  worktreeBranch: string | null
  width: number
  palette: Palette
}): React.JSX.Element {
  const nameLine = buildSummaryLine('archive', workspaceName, width)
  const branchLine =
    worktreeBranch != null ? buildSummaryLine('branch', worktreeBranch, width) : null
  return (
    <>
      <Text bold color={palette.attention} wrap="truncate-end">
        permanent — deletes worktree
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={palette.text} wrap="truncate-end">
          {nameLine}
        </Text>
        {branchLine != null ? (
          <Text color={palette.text} wrap="truncate-end">
            {branchLine}
          </Text>
        ) : null}
      </Box>
      <Box marginTop={1}>
        <Text color={palette.secondary} wrap="truncate-end">
          {'d continue   esc cancel'}
        </Text>
      </Box>
    </>
  )
}

/** Archive stage 2: the actual point of no return — a DIFFERENT key (enter) required. */
function ArchiveExecuteBody({
  workspaceName,
  width,
  palette
}: {
  workspaceName: string
  width: number
  palette: Palette
}): React.JSX.Element {
  const line = buildSummaryLine('delete', workspaceName, width)
  return (
    <>
      <Text bold color={palette.attention} wrap="truncate-end">
        this cannot be undone
      </Text>
      <Box marginTop={1}>
        <Text color={palette.text} wrap="truncate-end">
          {line}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={palette.secondary} wrap="truncate-end">
          {'enter delete permanently   esc cancel'}
        </Text>
      </Box>
    </>
  )
}

export function CloseArchiveConfirm({
  mode,
  archiveStage,
  workspaceName,
  worktreeBranch,
  submitting,
  submitError,
  width,
  palette
}: CloseArchiveConfirmProps): React.JSX.Element {
  const innerWidth = Math.max(BOX_WIDTH_FLOOR, width)
  return (
    <Box flexDirection="column">
      {mode === 'close' ? (
        <CloseBody workspaceName={workspaceName} width={innerWidth} palette={palette} />
      ) : archiveStage === 'confirm' ? (
        <ArchiveConfirmBody
          workspaceName={workspaceName}
          worktreeBranch={worktreeBranch}
          width={innerWidth}
          palette={palette}
        />
      ) : (
        <ArchiveExecuteBody workspaceName={workspaceName} width={innerWidth} palette={palette} />
      )}
      {submitting || submitError != null ? (
        <Box marginTop={1}>
          <StatusLine submitting={submitting} submitError={submitError} palette={palette} />
        </Box>
      ) : null}
    </Box>
  )
}
