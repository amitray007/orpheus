/**
 * reads/resolve-name.ts — CLI-side workspace display-name resolution.
 *
 * PARITY WITH THE GUI
 * --------------------
 * The GUI never shows a workspace's raw DB `name` column for auto-named
 * workspaces — it runs a resolution ladder (see
 * src/renderer/src/components/dashboard/resolveWorkspaceName.ts):
 *
 *   1. Manual name (nameIsAuto === false)        → workspace.name, always wins.
 *   2. Live terminal OSC title (terminalTitle)   → beats everything else while
 *      the workspace's terminal surface is mounted and Claude has emitted a
 *      title escape sequence.
 *   3. Persisted terminal title (lastTitle)      → the DB's last-known OSC
 *      title, kept so a reopened/closed workspace still shows something
 *      terminal-derived before Claude re-emits the live title.
 *   4. Closed workspace with no terminal title   → muted "New workspace".
 *      (sessionTitle is intentionally skipped for closed workspaces — no
 *      reversion to the first-prompt title once closed.)
 *   5. First-prompt sessionTitle (from the transcript JSONL) → for open
 *      workspaces that never got a terminal title.
 *   6. Muted "New workspace".
 *
 * WHY THE CLI LADDER IS SHORTER
 * ------------------------------
 * Rung 2 (the *live* OSC terminal title) requires an attached libghostty
 * surface inside the running Electron process — that signal simply does not
 * exist off-disk, so the CLI cannot read it. It has no analogue we can
 * reconstruct from SQLite or the filesystem. `lastTitle` (rung 3) is the
 * persisted equivalent of that signal and is captured whenever the app is
 * running, so in practice it covers the common case (a workspace that has
 * been opened before) even when the CLI is asked about a workspace that
 * currently has no live surface. The result is: manual name → lastTitle →
 * closed-with-no-title → sessionTitle → fallback. This is a strict subset of
 * the GUI ladder with rung 2 elided — never a *different* precedence.
 */

import type { WorkspaceRecord, ProjectRecord } from './db.js'
import { resolveTranscriptPath } from './transcript.js'
import * as fs from 'node:fs'

/** Muted fallback text used when no name signal is available (mirrors the GUI). */
export const FALLBACK_WORKSPACE_NAME = 'New workspace'

const MAX_BYTES = 200 * 1024 // 200 KB — bounded read, mirrors src/main/sessions.ts extractTitle
const MAX_TITLE_LENGTH = 60

/**
 * Extract a session title from a workspace's transcript JSONL: the first
 * ~60 chars of the first `{ type: 'user', message: { content } }` entry.
 *
 * Mirrors extractTitle() in src/main/sessions.ts (bounded 200KB read, scan
 * for the first user message, truncate to 60 chars with an ellipsis).
 *
 * Returns null when:
 *   - the workspace has no claudeSessionId yet (no session started)
 *   - the transcript file doesn't exist
 *   - the file can't be read or parsed (tolerated — never throws)
 *   - no user message is found in the first MAX_BYTES of the file
 */
export function extractSessionTitle(
  workspace: WorkspaceRecord,
  project: ProjectRecord
): string | null {
  const jsonlPath = resolveTranscriptPath(workspace, project)
  if (jsonlPath == null) return null

  try {
    const fd = fs.openSync(jsonlPath, 'r')
    let bytesRead: number
    const buf = Buffer.allocUnsafe(MAX_BYTES)
    try {
      bytesRead = fs.readSync(fd, buf, 0, MAX_BYTES, 0)
    } finally {
      fs.closeSync(fd)
    }

    const text = buf.slice(0, bytesRead).toString('utf-8')
    const lines = text.split('\n')

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        continue
      }

      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        (parsed as Record<string, unknown>)['type'] !== 'user'
      ) {
        continue
      }

      const message = (parsed as Record<string, unknown>)['message']
      if (typeof message !== 'object' || message === null) continue

      const content = (message as Record<string, unknown>)['content']
      let raw: string | null = null

      if (typeof content === 'string') {
        raw = content
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (
            typeof part === 'object' &&
            part !== null &&
            (part as Record<string, unknown>)['type'] === 'text'
          ) {
            const t = (part as Record<string, unknown>)['text']
            if (typeof t === 'string') {
              raw = t
              break
            }
          }
        }
      }

      if (raw) {
        const trimmedRaw = raw.trim()
        if (!trimmedRaw) continue
        return trimmedRaw.length > MAX_TITLE_LENGTH
          ? trimmedRaw.slice(0, MAX_TITLE_LENGTH) + '…'
          : trimmedRaw
      }
    }
  } catch {
    // Any IO / parse error → null, caller falls back down the ladder.
  }
  return null
}

/**
 * Resolve the display name for a workspace, replicating the disk-available
 * rungs of the GUI's resolveWorkspaceName() ladder (see module doc above for
 * the full rationale). `sessionTitle` should be pre-extracted via
 * extractSessionTitle() (or passed as null when unavailable/not yet computed
 * — e.g. to avoid an unnecessary disk read when a cheaper rung already won).
 *
 * Empty-string values are treated as absent, matching the GUI's falsy checks.
 */
export function resolveWorkspaceDisplayName(
  workspace: WorkspaceRecord,
  sessionTitle: string | null
): string {
  // 1. Manual name always wins.
  if (!workspace.nameIsAuto) return workspace.name

  // 2. (GUI-only) live terminal OSC title — not available off-disk, skipped.

  // 3. Persisted terminal title — the disk-available stand-in for rung 2.
  if (workspace.lastTitle) return workspace.lastTitle

  // 4. Closed workspace with no terminal title: don't revert to first prompt.
  if (workspace.closedAt !== null) return FALLBACK_WORKSPACE_NAME

  // 5. First-prompt session title.
  if (sessionTitle) return sessionTitle

  // 6. Fallback.
  return FALLBACK_WORKSPACE_NAME
}
