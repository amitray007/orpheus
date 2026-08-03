/**
 * tui-otui/types.ts — frame/protocol types for the OpenTUI picker's
 * /subscribe consumer.
 *
 * DELIBERATELY LOCAL, NOT IMPORTED FROM tui/types.ts OR src/shared/types.ts
 * -----------------------------------------------------------------------
 * Same rationale tui/types.ts documents for its own independence from
 * src/shared/types.ts: this package stays loosely coupled to whichever
 * process owns the wire contract, and a local copy means a server-side
 * drift only requires touching this one file. This is a SEPARATE local copy
 * from tui/types.ts (not a re-export) per the task brief — the Ink tui/
 * directory is explicitly out of scope for this change.
 *
 * Additions beyond tui/types.ts: `WorkspaceHostResult.refused`, mirroring
 * src/main/commandServer.ts's actual `workspace.host` response shape
 * (~line 775-790) and src/shared/types.ts's `WorkspaceHostResult`;
 * `TreeWorkspace.model`/`effort`, mirroring src/shared/types.ts's
 * `TreeWorkspaceFrame` (card redesign — see docs/TUI_SPEC.md); and
 * `TreeWorkspace.gitBranch`, mirroring src/shared/types.ts's own `gitBranch`
 * field (see that file's doc comment for the full rationale) — the card's
 * branch line (WorkspaceCard.tsx) computes `worktreeBranch ?? gitBranch` at
 * render time, matching src/shared/types.ts's documented display precedence.
 */

/** Workspace activity status, as emitted in a `tree` frame's workspace rows. */
export type WorkspaceStatus = 'attention' | 'in_progress' | 'awaiting_input' | 'idle'

/** A single workspace row inside a `tree` frame's per-project `workspaces` array. */
export interface TreeWorkspace {
  id: string
  name: string
  status: WorkspaceStatus
  waitingFor?: string | null
  parentWorkspaceId?: string | null
  worktreeBranch?: string | null
  /** The workspace cwd's actual current git branch, resolved independently
   *  server-side on every tree frame — see src/shared/types.ts's own
   *  `gitBranch` field doc comment for the full rationale. Optional so an
   *  older server that hasn't shipped this field yet still renders (card
   *  falls back to a blank branch line, same as before this field existed).
   *  DISPLAY PRECEDENCE (card's branch line): `worktreeBranch ?? gitBranch` —
   *  `worktreeBranch` wins when non-null, `gitBranch` is the fallback that
   *  actually populates the line for ordinary (non-worktree) workspaces. */
  gitBranch?: string | null
  sortOrder?: number | null
  tmuxHosted?: boolean
  lastActivityAt?: number | null
  /** Live OSC terminal title Claude Code sets while working; falls back to
   *  `name` when null/empty/absent. */
  lastTitle?: string | null
  /** Effective (layered) Claude model for this workspace — see
   *  src/main/claudeSettings.ts's resolveEffectiveModelAndEffort and
   *  src/shared/types.ts's TreeWorkspaceFrame (this is a local copy of that
   *  wire field, per this file's own header on why tui-otui keeps its own
   *  copy instead of importing src/shared/types.ts). Optional so an older
   *  server that hasn't shipped this field yet still renders (card omits
   *  the model/effort line's content, not the whole card). */
  model?: string | null
  /** Effective effort for this workspace, same resolution ladder as `model`. */
  effort?: string | null
}

/** A single project group inside a `tree` frame. */
export interface TreeProject {
  id: string
  name: string
  cwd: string
  sortOrder?: number | null
  workspaces: TreeWorkspace[]
}

/** The full-snapshot `tree` frame streamed over `/subscribe` (see docs/TUI_SPEC.md D5). */
export interface TreeFrame {
  type: 'tree'
  revision: number
  projects: TreeProject[]
}

/** Narrow the shape of an arbitrary `/subscribe` frame down to a TreeFrame. */
export function isTreeFrame(evt: unknown): evt is TreeFrame {
  if (evt == null || typeof evt !== 'object') return false
  const rec = evt as Record<string, unknown>
  return rec.type === 'tree' && typeof rec.revision === 'number' && Array.isArray(rec.projects)
}

/**
 * Response shape of the `workspace.host` action. `refused` is present (with
 * `created`/`alreadyRunning` both false) when the workspace is currently
 * live natively on the desktop — see src/main/commandServer.ts's
 * `shouldBlockTmuxHost` guard and docs/TUI_SPEC.md's `workspace.host`
 * section.
 */
export interface WorkspaceHostResult {
  sessionName: string
  socketName: string
  created: boolean
  alreadyRunning: boolean
  refused?: { reason: 'open-on-desktop'; message: string }
}
