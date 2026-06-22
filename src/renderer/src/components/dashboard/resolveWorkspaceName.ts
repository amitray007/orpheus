import type { WorkspaceRecord } from '@shared/types'

/**
 * Resolve the display name for a workspace following the canonical ladder:
 *   1. Manual name (nameIsAuto === false) — always wins.
 *   2. Live terminal OSC title.
 *   3. First user prompt from the workspace's claude session (session title).
 *   4. Fallback: muted italic "New workspace" — shown only after the
 *      initial hide window (see WorkspaceSubRow / WorkspaceCard) so the
 *      user never sees it flash in for <3 s on a fresh workspace.
 */
export function resolveWorkspaceName(args: {
  workspace: WorkspaceRecord
  terminalTitle: string | null
  sessionTitle: string | null
}): { text: string; muted: boolean } {
  const { workspace, terminalTitle, sessionTitle } = args

  if (!workspace.nameIsAuto) return { text: workspace.name, muted: false }
  if (terminalTitle) return { text: terminalTitle, muted: false }
  if (sessionTitle) return { text: sessionTitle, muted: false }
  if (workspace.lastTitle) return { text: workspace.lastTitle, muted: false }

  return { text: 'New workspace', muted: true }
}
