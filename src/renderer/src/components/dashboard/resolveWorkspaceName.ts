import type { WorkspaceRecord } from '@shared/types'

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  const s = Math.floor(diff / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  return `${mo}mo ago`
}

/**
 * Resolve the display name for a workspace following the canonical ladder:
 *   1. Manual name (nameIsAuto === false) — always wins.
 *   2. Live terminal OSC title.
 *   3. First user prompt from the workspace's claude session (session title).
 *   4. Fallback: muted italic "untitled · <relative time> · <short id>".
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

  const shortId = workspace.id.slice(0, 6)
  const when = relativeTime(workspace.createdAt)
  return { text: `untitled · ${when} · ${shortId}`, muted: true }
}
