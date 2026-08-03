/**
 * tui/types.ts — frame/protocol types for the TUI's /subscribe consumer.
 *
 * DELIBERATELY LOCAL, NOT IMPORTED FROM src/shared/types.ts
 * -----------------------------------------------------------
 * src/shared/types.ts is being edited concurrently (by the agent implementing
 * the main-process/commandServer.ts half of this feature) and the CLI package
 * is meant to stay loosely coupled to it anyway (see docs/TUI_SPEC.md). These
 * types mirror the wire shape documented there; if the server's actual shape
 * drifts, only this file needs to change.
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
   *  falls back to a blank branch line). DISPLAY PRECEDENCE (card's branch
   *  line): `worktreeBranch ?? gitBranch` — `worktreeBranch` wins when
   *  non-null, `gitBranch` is the fallback that actually populates the line
   *  for ordinary (non-worktree) workspaces. */
  gitBranch?: string | null
  sortOrder?: number | null
  tmuxHosted?: boolean
  lastActivityAt?: number | null
  /** Live OSC terminal title Claude Code sets while working; falls back to
   *  `name` when null/empty/absent. */
  lastTitle?: string | null
  /** Effective (layered) Claude model for this workspace — see
   *  src/main/claudeSettings.ts's resolveEffectiveModelAndEffort and
   *  src/shared/types.ts's TreeWorkspaceFrame. Optional so an older server
   *  that hasn't shipped this field yet still renders (card omits the
   *  model/effort line's content, not the whole card). */
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

/**
 * The full-snapshot `tree` frame streamed over `/subscribe` (see
 * docs/TUI_SPEC.md D5). Snapshots are applied wholesale by `revision` — a
 * frame with a revision <= the last-applied one is ignored (self-heals a
 * dropped frame on a flaky link; reconnect is free since the server resends
 * a fresh snapshot).
 */
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

/** Response shape of the `workspace.host` action (see docs/TUI_SPEC.md). */
export interface WorkspaceHostResult {
  sessionName: string
  socketName: string
  created: boolean
  alreadyRunning: boolean
}
