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
 * The one addition beyond tui/types.ts: `WorkspaceHostResult.refused`,
 * mirroring src/main/commandServer.ts's actual `workspace.host` response
 * shape (~line 775-790) and src/shared/types.ts's `WorkspaceHostResult`.
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
  sortOrder?: number | null
  tmuxHosted?: boolean
  lastActivityAt?: number | null
  /** Live OSC terminal title Claude Code sets while working; falls back to
   *  `name` when null/empty/absent. */
  lastTitle?: string | null
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
