/**
 * tui/components/wizard/NameStep.tsx — Step 2 of the new-workspace wizard: a
 * single-line, hand-rolled text input for the workspace name.
 *
 * NO TEXT-INPUT LIBRARY — orpheus-cli's package.json has zero dependencies
 * today (confirmed by reading it before writing this file); adding
 * `ink-text-input` just for one field would be the first dependency this
 * package ever took on. A printable-chars + backspace + left/right + enter
 * buffer is maybe 20 lines and matches this codebase's existing bias (see
 * CLAUDE.md's "minimal deps" note and layout.ts's own hand-rolled
 * `truncate()` rather than reaching for a wrapping library).
 *
 * THE BUFFER LIVES IN WizardState, NOT LOCAL COMPONENT STATE — every
 * keystroke is dispatched through NewWorkspaceWizard.tsx's `useInput`
 * handler (same single-owner pattern as App.tsx's own top-level useInput),
 * so this component is a pure renderer of `{ name, namePos }`, not a second
 * place that owns text-editing logic. See handleNameKey() in
 * NewWorkspaceWizard.tsx for the actual buffer mutation.
 *
 * EMPTY IS A VALID, INTENTIONAL SUBMISSION — the task brief requires the
 * screen to say so explicitly (an empty enter is easy to mistake for "did
 * nothing happen"), since the backend defaults the name server-side when
 * the arg is omitted (commandServer.ts's handleLegacyWorkspaceCreate only
 * sets `name` when it's a non-empty string).
 */

import * as React from 'react'
import { Box, Text } from 'ink'
import { CARD_GUTTER_WIDTH, CARD_PAD_GUTTER } from '../../theme.js'
import type { Palette } from '../../theme.js'

export interface NameStepProps {
  name: string
  namePos: number
  width: number
  palette: Palette
}

/** Cursor rendered as an inverse-video single space at `namePos` — no new
 *  glyph (per the task brief's East_Asian_Width discipline), just a
 *  background-swap on whichever character (or trailing blank) it sits over.
 *  Splitting the string into three <Text> runs (before/cursor/after) keeps
 *  this exactly analogous to WorkspaceCard's own "colour is applied to an
 *  already-decided substring" discipline — no padEnd needed here since
 *  there's no full-row background tint on this screen, only the one-cell
 *  cursor swap. */
function NameInputLine({
  name,
  namePos,
  palette
}: {
  name: string
  namePos: number
  palette: Palette
}): React.JSX.Element {
  const before = name.slice(0, namePos)
  const atCursor = namePos < name.length ? name[namePos] : ' '
  const after = namePos < name.length ? name.slice(namePos + 1) : ''
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

export function NameStep({ name, namePos, width, palette }: NameStepProps): React.JSX.Element {
  void width // reserved: this screen renders one unwrapped input line and
  // two hint lines, none of which need manual column budgeting today — kept
  // as a prop for signature symmetry with the other step components and in
  // case a future name-length cap needs to render remaining-chars here.
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box paddingLeft={CARD_GUTTER_WIDTH + CARD_PAD_GUTTER}>
        <Text bold color={palette.groupLabel} wrap="truncate-end">
          Workspace name
        </Text>
      </Box>
      <Box paddingLeft={CARD_GUTTER_WIDTH + CARD_PAD_GUTTER} marginTop={1}>
        <NameInputLine name={name} namePos={namePos} palette={palette} />
      </Box>
      <Box flexGrow={1} />
      <Text color={palette.secondary} wrap="truncate-end">
        press enter to use the default name
      </Text>
      <Text color={palette.secondary} wrap="truncate-end">
        esc back
      </Text>
    </Box>
  )
}
