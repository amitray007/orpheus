/**
 * tui-otui/components/DetailPane.tsx — the wide-tier (>=120 cols) right pane
 * showing the currently-selected workspace's detail: project, branch,
 * workspace id, last activity, hosting mode.
 *
 * This is the redesign's answer to "wide widths gain whitespace, not
 * information" (docs/TUI_UI_REDESIGN.md problem #1) — the dead space to the
 * right of a list that only ever got WIDER padding now shows real per-row
 * detail instead.
 *
 * FIELD AVAILABILITY — SCOPED TO THE /subscribe WIRE FRAME, NOTHING ADDED
 * -----------------------------------------------------------------------
 * The task brief asks for "project name, branch, session id, last activity,
 * tmux session name, hosting mode". Per docs/TUI_SPEC.md's `tree` frame
 * shape (which this task must not change — constraint: don't touch the
 * `/subscribe` wire protocol), a TreeWorkspace carries only: id, name,
 * status, waitingFor, parentWorkspaceId, worktreeBranch, sortOrder,
 * tmuxHosted, lastActivityAt. There is no literal "tmux session name" or
 * "claude session id" field on the wire — those are server-internal
 * (docs/TUI_SPEC.md's hosting section derives the tmux session name
 * server-side only when workspace.host is actually called). So:
 *   - "session id" is shown as the workspace id itself — per this repo's own
 *     domain model (CLAUDE.md: "each workspace = one claude session"), the
 *     workspace id IS the stable identifier for that session in every sense
 *     the TUI can observe.
 *   - "tmux session name" is NOT fabricated — showing a guessed name would
 *     be actively misleading if wrong. Hosting mode (tmuxHosted) is shown
 *     instead, which is exactly what's on the wire and exactly what the
 *     user needs to know at a glance ("is this workspace live in tmux right
 *     now"). Flagged explicitly in the final report as a deliberate,
 *     wire-protocol-respecting scope cut, not an oversight.
 *
 * ROW-COLLAPSE BUG FOUND + FIXED DURING LIVE VERIFICATION (tui-mcp, 125x15)
 * -----------------------------------------------------------------------
 * The first version had no explicit `flexShrink={0}` on any row inside the
 * pane's flexGrow/minHeight=0 column — when the pane's total content height
 * (title + 6 two-row Fields + a rule + footer, ~21 rows) exceeded the
 * available body height (12 rows at a short terminal), Yoga's DEFAULT
 * flexShrink:1 on every child shrank them proportionally toward zero
 * height, which visibly manifested as label and value text overlapping on
 * the SAME terminal row ("status" + "○ idle" rendering as "○tidle"). Fixed
 * two ways together: (1) every row-shaped element in this file now carries
 * `flexShrink={0}` so no row is ever asked to compress below one line, and
 * (2) the whole field LIST is wrapped in a `<scrollbox>` so content that
 * still doesn't fit scrolls instead of being squeezed — the detail pane can
 * now never visually corrupt itself regardless of how short the terminal
 * is or how many fields a future change adds.
 */

import { TextAttributes } from '@opentui/core'
import { Show } from 'solid-js'
import { displayTitleFor, type DisplayRow } from '../../tui/layout.js'
import type { Palette } from '../theme.js'
import { formatAgeLong } from '../format.js'
import { spinnerGlyph } from '../spinner.js'
import type { WorkspaceStatus } from '../types.js'
import { Rule } from './Rule.js'

const STATUS_LABEL: Record<WorkspaceStatus, string> = {
  attention: 'needs attention',
  in_progress: 'working',
  awaiting_input: 'awaiting input',
  idle: 'idle'
}

function statusColor(status: WorkspaceStatus, palette: Palette): string {
  if (status === 'attention') return palette.attention
  if (status === 'in_progress') return palette.working
  if (status === 'awaiting_input') return palette.awaiting
  return palette.idle
}

function statusGlyph(status: WorkspaceStatus): string {
  if (status === 'attention') return '!'
  if (status === 'in_progress') return spinnerGlyph()
  return '○'
}

export interface DetailPaneProps {
  row: Extract<DisplayRow, { kind: 'workspace' }> | null
  projectName: string | null
  palette: Palette
}

function Field(props: { label: string; children: JSX.Element; palette: Palette }): JSX.Element {
  return (
    <box flexDirection="column" flexShrink={0} marginBottom={1}>
      <text
        fg={props.palette.secondary}
        wrapMode="none"
        overflow="hidden"
        flexShrink={0}
        height={1}
      >
        {props.label}
      </text>
      <text wrapMode="none" overflow="hidden" flexShrink={0} height={1}>
        {props.children}
      </text>
    </box>
  )
}

export function DetailPane(props: DetailPaneProps): JSX.Element {
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} paddingLeft={2} paddingTop={0}>
      <Show
        when={props.row != null}
        fallback={
          <text fg={props.palette.secondary} wrapMode="none">
            no workspace selected
          </text>
        }
      >
        {(() => {
          const row = props.row!
          return (
            <scrollbox flexGrow={1} minHeight={0}>
              <text
                fg={props.palette.accent}
                attributes={TextAttributes.BOLD}
                wrapMode="none"
                overflow="hidden"
                flexShrink={0}
                height={1}
              >
                {displayTitleFor(row)}
              </text>
              <box height={1} flexShrink={0} />
              <Field label="status" palette={props.palette}>
                <span fg={statusColor(row.status, props.palette)}>{statusGlyph(row.status)} </span>
                <span fg={statusColor(row.status, props.palette)}>{STATUS_LABEL[row.status]}</span>
                {row.waitingFor != null ? (
                  <span fg={props.palette.secondary}> — {row.waitingFor}</span>
                ) : null}
              </Field>
              <Field label="workspace" palette={props.palette}>
                <span fg={props.palette.text}>{row.name}</span>
              </Field>
              <Field label="project" palette={props.palette}>
                <span fg={props.palette.text}>{props.projectName ?? '—'}</span>
              </Field>
              <Field label="branch" palette={props.palette}>
                <span fg={props.palette.text}>{row.worktreeBranch ?? '—'}</span>
              </Field>
              <Field label="session id" palette={props.palette}>
                <span fg={props.palette.text}>{row.workspaceId}</span>
              </Field>
              <Field label="last activity" palette={props.palette}>
                <span fg={props.palette.text}>{formatAgeLong(row.lastActivityAt)}</span>
              </Field>
              <Field label="hosting" palette={props.palette}>
                <span fg={row.tmuxHosted ? props.palette.working : props.palette.secondary}>
                  {row.tmuxHosted ? 'live in tmux' : 'not hosted'}
                </span>
              </Field>
              <Rule palette={props.palette} />
              <box height={1} flexShrink={0} />
              <text fg={props.palette.secondary} wrapMode="none" flexShrink={0} height={1}>
                ↵ open this workspace
              </text>
            </scrollbox>
          )
        })()}
      </Show>
    </box>
  )
}
