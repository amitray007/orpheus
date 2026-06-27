import type { WorkspaceRecord } from '@shared/types'

/**
 * Resolve the display name for a workspace following the canonical ladder:
 *   1. Manual name (nameIsAuto === false) — always wins.
 *   2. Live terminal OSC title (terminalTitle) — beats everything else while active.
 *   3. Persisted terminal title (lastTitle) — preferred over the first prompt so a
 *      reopened workspace stays on its terminal-derived name during the window
 *      before Claude re-emits the OSC title.
 *   4. Closed workspace with no terminal title: muted "New workspace".
 *      sessionTitle is skipped for closed workspaces — no reversion to first prompt.
 *   5. First-prompt sessionTitle — for open workspaces that never had a terminal title.
 *   6. Muted "New workspace".
 *
 * Empty-string values are treated as absent (falsy checks).
 */
export function resolveWorkspaceName(args: {
  workspace: WorkspaceRecord
  terminalTitle: string | null
  sessionTitle: string | null
}): { text: string; muted: boolean } {
  const { workspace, terminalTitle, sessionTitle } = args

  if (!workspace.nameIsAuto) return { text: workspace.name, muted: false }
  if (terminalTitle) return { text: terminalTitle, muted: false }
  if (workspace.lastTitle) return { text: workspace.lastTitle, muted: false }
  if (workspace.closedAt !== null) return { text: 'New workspace', muted: true }
  if (sessionTitle) return { text: sessionTitle, muted: false }

  return { text: 'New workspace', muted: true }
}
