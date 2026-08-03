/**
 * tui/components/DetailPane.tsx — the wide-tier (>=120 cols) right pane
 * showing the currently-selected workspace's detail: project, branch,
 * workspace id, last activity, hosting mode.
 *
 * Direct port of tui-otui/components/DetailPane.tsx — see that file's
 * header for the full field-availability rationale (this is scoped strictly
 * to what the `/subscribe` tree frame actually carries; "session id" is
 * shown as the workspace id itself, "tmux session name" is deliberately NOT
 * fabricated — hosting mode is shown instead).
 *
 * NO SCROLLBOX EQUIVALENT (Ink-specific deviation, reported honestly) — the
 * OpenTUI build wraps its field list in a `<scrollbox>` so content that
 * doesn't fit the available height scrolls instead of corrupting the
 * layout. Ink has no interactive-scroll primitive. This uses a Box with
 * `overflowY="hidden"` instead: content that doesn't fit is CLIPPED (from
 * the bottom), not squeezed/overlapping — which was the actual bug the
 * OpenTUI scrollbox fix addressed (label/value text overlapping on one
 * row). Clipping is a fixed-height-safe, non-corrupting fallback but is
 * NOT a full substitute for the OpenTUI version's scroll interaction — a
 * short terminal with many fields loses the tail of the pane rather than
 * being able to scroll to see it. Every row still carries `flexShrink={0}`
 * so Yoga never compresses a row below one line (the actual fix for the
 * overlap bug); the overflow clip is the fallback for genuine overflow.
 */

import * as React from 'react'
import { Box, Text } from 'ink'
import { displayTitleFor, type DisplayRow } from '../layout.js'
import type { Palette } from '../theme.js'
import { formatAgeLong } from '../format.js'
import type { WorkspaceStatus } from '../types.js'
import { Rule } from './Rule.js'

const STATUS_LABEL: Record<WorkspaceStatus, string> = {
  attention: 'attention',
  in_progress: 'in progress',
  awaiting_input: 'awaiting',
  idle: 'idle'
}

function statusColor(status: WorkspaceStatus, palette: Palette): string {
  if (status === 'attention') return palette.attention
  if (status === 'in_progress') return palette.working
  if (status === 'awaiting_input') return palette.awaiting
  return palette.idle
}

export interface DetailPaneProps {
  row: Extract<DisplayRow, { kind: 'workspace' }> | null
  projectName: string | null
  /** Current git branch of the selected workspace's cwd — same source and
   *  same `worktreeBranch ?? gitBranch` precedence WorkspaceCard uses for
   *  its line 3, so the pane and the card beside it can never disagree. */
  gitBranch: string | null
  palette: Palette
  /** Content width available inside the pane (App.tsx's DETAIL_PANE_WIDTH
   *  minus any padding it applies). */
  width: number
  /** Rows available for the pane's content — used for the overflow-clip
   *  Box below (see file header's "NO SCROLLBOX EQUIVALENT" note). */
  rows: number
}

function Field({
  label,
  palette,
  children
}: {
  label: string
  palette: Palette
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Box flexDirection="column" flexShrink={0} marginBottom={1}>
      <Text color={palette.secondary} wrap="truncate-end">
        {label}
      </Text>
      <Text wrap="truncate-end">{children}</Text>
    </Box>
  )
}

export function DetailPane({
  row,
  projectName,
  gitBranch,
  palette,
  width,
  rows
}: DetailPaneProps): React.JSX.Element {
  if (row == null) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text color={palette.secondary}>no workspace selected</Text>
      </Box>
    )
  }

  const branch = row.worktreeBranch ?? gitBranch

  return (
    <Box flexDirection="column" paddingLeft={2} height={Math.max(1, rows)} overflowY="hidden">
      <Text bold color={palette.accent} wrap="truncate-end">
        {displayTitleFor(row)}
      </Text>
      <Box height={1} flexShrink={0} />
      <Field label="status" palette={palette}>
        <Text color={statusColor(row.status, palette)} bold={row.status === 'attention'}>
          {STATUS_LABEL[row.status]}
        </Text>
        {row.waitingFor != null ? <Text color={palette.secondary}> — {row.waitingFor}</Text> : null}
      </Field>
      <Field label="workspace" palette={palette}>
        <Text color={palette.text}>{row.name}</Text>
      </Field>
      <Field label="project" palette={palette}>
        <Text color={palette.text}>{projectName ?? '—'}</Text>
      </Field>
      <Field label="branch" palette={palette}>
        <Text color={palette.text}>{branch ?? '—'}</Text>
      </Field>
      {/* Labelled "workspace id", not "session id": the claude session id is
          server-internal and never reaches the CLI wire — see this file's
          header. */}
      <Field label="workspace id" palette={palette}>
        <Text color={palette.text}>{row.workspaceId}</Text>
      </Field>
      <Field label="last activity" palette={palette}>
        <Text color={palette.text}>{formatAgeLong(row.lastActivityAt)}</Text>
      </Field>
      <Field label="hosting" palette={palette}>
        <Text color={row.tmuxHosted ? palette.working : palette.secondary}>
          {row.tmuxHosted ? 'live in tmux' : 'not hosted'}
        </Text>
      </Field>
      <Rule palette={palette} width={Math.max(0, width)} />
      <Box height={1} flexShrink={0} />
      <Text color={palette.secondary} wrap="truncate-end">
        enter to open this workspace
      </Text>
    </Box>
  )
}
