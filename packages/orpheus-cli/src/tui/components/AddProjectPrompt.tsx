/**
 * tui/components/AddProjectPrompt.tsx — the `p` (add project) overlay: a
 * small full-width screen where the user types a filesystem path, `enter`
 * submits it via the `project.add` command-socket action, `esc` cancels.
 *
 * WHY A NEW OVERLAY RATHER THAN REUSING THE WIZARD OR CLOSE/ARCHIVE CONFIRM
 * -----------------------------------------------------------------------
 * Structurally this is closest to CloseArchiveConfirm.tsx (a compact,
 * non-full-screen box App.tsx stacks where the footer normally sits, with
 * the same submitting/submitError inline lifecycle) — EXCEPT it needs a text
 * buffer, which neither CloseArchiveConfirm nor the wizard's remaining steps
 * have any more (the wizard's own text-entry step was removed, see
 * addProjectLayout.ts's header). So this is its own small component: the
 * close/archive shape (compact box, StatusLine pattern) plus one text-input
 * line, following the removed NameStep.tsx's rendering approach for that
 * line specifically (see addProjectLayout.ts's buildPathFieldWindow for the
 * buffer/scrolling math that replaces NameStep's simpler no-scroll version —
 * a path is far more likely to exceed the field width than a workspace
 * name was).
 *
 * OWNERSHIP: App.tsx owns the open/closed state (a single nullable
 * `addProjectOpen: boolean`, mirroring `wizardProject`/`closeArchive`) and
 * short-circuits its own useInput while this is open, exactly like the
 * wizard and close/archive overlays already do. This component owns its OWN
 * buffer/submit state (mirrors NewWorkspaceWizard.tsx being the sole owner
 * of its step machine) — App.tsx never reaches into it.
 *
 * ON SUCCESS: per the task brief, do NOT manually refetch — the tree frame
 * arrives over the existing /subscribe connection (frameStore.ts), and
 * addProject() atomically creates the project's default workspace too, so
 * the new project simply appears in the next frame. This component only
 * needs to call onDone() to close itself.
 */

import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { sendCommand } from '../../socket-client.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import {
  applyCompletion,
  backspace,
  buildPathFieldWindow,
  commonPrefix,
  insertText,
  moveCursor,
  pathFieldInnerWidth,
  splitForCompletion,
  type PathBuffer
} from '../addProjectLayout.js'
import type { Palette } from '../theme.js'

export interface AddProjectPromptProps {
  width: number
  palette: Palette
  /** Called once the overlay is done, one way or another — mirrors
   *  NewWorkspaceWizard.tsx's onDone, but there is no created-id to report:
   *  App.tsx never needs to navigate anywhere on success (unlike creating a
   *  workspace, adding a project isn't "intent to work in it" — the user
   *  picks a workspace from the newly-visible project the normal way). */
  onDone: () => void
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Mirrors CloseArchiveConfirm.tsx's/wizard/WizardScreens.tsx's own
 *  StatusLine/SubmitStatusLine — same submitting/error shape, same "renders
 *  nothing in the idle case" contract so it costs zero rows otherwise. */
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
        adding…
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

/** The single-line path input — cursor rendered as an inverse-video single
 *  space at the field-local cursor column, same technique the removed
 *  NameStep.tsx used (see that file, referenced in addProjectLayout.ts's
 *  header): no new glyph, just a background-swap on whichever character (or
 *  padded blank) the cursor sits over, so this stays clear of every
 *  East_Asian_Width=Ambiguous glyph risk. Unlike NameStep, the text here is
 *  ALREADY windowed/padded to exactly `innerWidth` by buildPathFieldWindow,
 *  so the three-way split below operates on that fixed-width string, not
 *  the raw buffer value. */
function PathInputLine({
  buffer,
  innerWidth,
  palette
}: {
  buffer: PathBuffer
  innerWidth: number
  palette: Palette
}): React.JSX.Element {
  const window = buildPathFieldWindow(buffer.value, buffer.cursorPos, innerWidth)
  const before = window.text.slice(0, window.cursorColumn)
  const atCursor = window.cursorColumn < window.text.length ? window.text[window.cursorColumn] : ' '
  const after =
    window.cursorColumn < window.text.length ? window.text.slice(window.cursorColumn + 1) : ''
  return (
    <Text wrap="truncate-end">
      <Text color={palette.text}>{before}</Text>
      <Text color={palette.text} backgroundColor={palette.selectedBg}>
        {atCursor}
      </Text>
      <Text color={palette.text}>{after}</Text>
    </Text>
  )
}

/**
 * Dispatches a single keypress to the path buffer, or triggers submit/cancel
 * — extracted from the component body for the same cognitive-complexity
 * reason every other useInput handler in this package is split out (see
 * App.tsx's handleViewKey/handleNewWorkspaceKey/handleCloseArchiveKey).
 */
function handlePathInputKey(
  input: string,
  key: {
    escape: boolean
    return: boolean
    backspace: boolean
    delete: boolean
    leftArrow: boolean
    rightArrow: boolean
  },
  setBuffer: React.Dispatch<React.SetStateAction<PathBuffer>>,
  submitting: boolean,
  onCancel: () => void,
  onSubmit: () => void
): void {
  if (submitting) return // ignore further presses mid-request — no double-submit
  if (key.escape) {
    onCancel()
    return
  }
  if (key.return) {
    onSubmit()
    return
  }
  if (key.leftArrow) {
    setBuffer((b) => moveCursor(b, -1))
    return
  }
  if (key.rightArrow) {
    setBuffer((b) => moveCursor(b, 1))
    return
  }
  if (key.backspace || key.delete) {
    setBuffer((b) => backspace(b))
    return
  }
  if (key.tab) {
    setBuffer((b) => completePath(b))
    return
  }
  // Printable character — same input.length>0 gate the removed NameStep's
  // handleNameKey used (wizardStepMachine.ts, commit d5ceebe5^): Ink reports
  // control/navigation keys via `key` with `input` empty or non-printable,
  // so everything reaching this branch (after every control-key check above
  // has already returned) is real typed text.
  if (input.length > 0) {
    setBuffer((b) => insertText(b, input))
  }
}

/**
 * Tab-completion over DIRECTORIES ONLY — project.add rejects anything that
 * isn't a directory (see src/main/projectPathResolve.ts), so offering files
 * would only ever complete to a value the server refuses.
 *
 * Best-effort by construction: an unreadable or nonexistent parent returns
 * the buffer unchanged rather than throwing or reporting an error. A failed
 * Tab should feel like "nothing to complete", which is exactly how a shell
 * behaves — the real feedback for a bad path is the submit error, which
 * already exists.
 *
 * Completes to the COMMON PREFIX of all matches, not the first match, so
 * repeated presses converge the way a shell does. A sole match gets a
 * trailing slash so the next Tab descends into it without the user typing
 * the separator.
 */
function completePath(buffer: PathBuffer): PathBuffer {
  const { dir, fragment } = splitForCompletion(buffer.value)
  // Expand `~` for the FILESYSTEM read only — the buffer keeps whatever the
  // user typed, since the server expands it too and rewriting their text
  // under them mid-edit is surprising.
  const readDir = dir.startsWith('~') ? nodePath.join(os.homedir(), dir.slice(1)) : dir
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(readDir, { withFileTypes: true })
  } catch {
    return buffer
  }
  const matches = entries
    .filter((e) => e.isDirectory() && e.name.startsWith(fragment))
    // Hidden directories are offered only once the user has typed the dot
    // themselves — otherwise `~/` on a home directory buries real projects
    // under dozens of dotfiles.
    .filter((e) => fragment.startsWith('.') || !e.name.startsWith('.'))
    .map((e) => e.name)
  if (matches.length === 0) return buffer
  const completed = matches.length === 1 ? `${matches[0]}/` : commonPrefix(matches)
  if (completed.length <= fragment.length) return buffer
  return applyCompletion(buffer, dir, completed)
}

export function AddProjectPrompt({
  width,
  palette,
  onDone
}: AddProjectPromptProps): React.JSX.Element {
  // PREFILLED WITH THE CWD, not empty. `orpheus tui` is almost always
  // launched from inside the project being added, so this turns the common
  // case into `p`, `enter` — no typing at all. When it's the wrong path it
  // is still a better start than a blank field: backspacing back up a real
  // path beats typing one from scratch on a phone keyboard. Cursor parks at
  // the end so typing continues the path rather than inserting at its head.
  const [buffer, setBuffer] = useState<PathBuffer>(() => {
    const cwd = process.cwd()
    return { value: cwd, cursorPos: cwd.length }
  })
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  async function submit(): Promise<void> {
    // An empty/whitespace-only path is never a meaningful submission (there
    // is no "default" the server can fall back to the way workspace.create's
    // name field could) — reject locally before ever touching the socket, so
    // the error reads as an immediate validation message rather than a round
    // trip to the server just to learn the same thing.
    const trimmed = buffer.value.trim()
    if (trimmed === '') {
      setSubmitError('enter a path')
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    try {
      await sendCommand('project.add', { path: trimmed })
      onDone()
    } catch (err) {
      setSubmitting(false)
      setSubmitError(errorMessage(err))
    }
  }

  useInput((input, key) => {
    handlePathInputKey(input, key, setBuffer, submitting, onDone, () => void submit())
  })

  const innerWidth = pathFieldInnerWidth(width)

  return (
    <Box flexDirection="column">
      <Text bold color={palette.groupLabel} wrap="truncate-end">
        Add project
      </Text>
      <Box marginTop={1}>
        <PathInputLine buffer={buffer} innerWidth={innerWidth} palette={palette} />
      </Box>
      <Box marginTop={1}>
        <Text color={palette.secondary} wrap="truncate-end">
          {submitError != null ? 'enter retry   esc cancel' : 'enter add  tab complete  esc cancel'}
        </Text>
      </Box>
      {submitting || submitError != null ? (
        <Box marginTop={1}>
          <StatusLine submitting={submitting} submitError={submitError} palette={palette} />
        </Box>
      ) : null}
    </Box>
  )
}
