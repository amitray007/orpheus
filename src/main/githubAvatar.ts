import { exec } from 'node:child_process'
import { BrowserWindow } from 'electron'
import { getDb } from './db'
import { PUSH_CHANNELS } from '../shared/ipc'

// Broadcast a partial update so the renderer can patch its local projects
// state in-place without re-fetching the whole list. Sends only the four
// GitHub fields plus the projectId so the renderer can `map` and merge.
function broadcastGithubUpdate(payload: {
  projectId: string
  githubOwner: string | null
  githubRepo: string | null
  githubAvatarUrl: string | null
  githubCheckedAt: number
}): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(PUSH_CHANNELS.projectsGithubDataUpdated, payload)
  }
}

// ---------------------------------------------------------------------------
// GitHub info extraction
// ---------------------------------------------------------------------------

// SSH:   git@github.com:owner/repo.git
const SSH_RE = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i

// HTTPS: https://github.com/owner/repo or .git
const HTTPS_RE = /^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i

export function extractGithubInfo(
  repoPath: string
): Promise<{ owner: string; repo: string } | null> {
  return new Promise((resolve) => {
    exec('git config --get remote.origin.url', { cwd: repoPath, timeout: 3000 }, (err, stdout) => {
      if (err || !stdout) {
        resolve(null)
        return
      }
      const url = stdout.trim()
      const sshMatch = SSH_RE.exec(url)
      if (sshMatch) {
        resolve({ owner: sshMatch[1], repo: sshMatch[2] })
        return
      }
      const httpsMatch = HTTPS_RE.exec(url)
      if (httpsMatch) {
        resolve({ owner: httpsMatch[1], repo: httpsMatch[2] })
        return
      }
      resolve(null)
    })
  })
}

// ---------------------------------------------------------------------------
// Avatar URL fetch
// ---------------------------------------------------------------------------

export async function fetchAvatarUrl(owner: string): Promise<string | null> {
  try {
    const res = await fetch(`https://github.com/${encodeURIComponent(owner)}.png?size=120`, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(5000)
    })
    if (res.ok) return res.url
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Pipeline: check toggle → read project path → extract → fetch → write
// ---------------------------------------------------------------------------

export async function refreshGithubData(projectId: string): Promise<void> {
  try {
    const db = getDb()

    // 1. Check the global privacy toggle
    const uiRow = db.prepare('SELECT fetch_github_avatars FROM app_ui_state WHERE id = 1').get() as
      | { fetch_github_avatars: number | null }
      | undefined
    const fetchEnabled = (uiRow?.fetch_github_avatars ?? 1) === 1
    if (!fetchEnabled) return

    // 2. Look up project path
    const projectRow = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as
      | { path: string }
      | undefined
    if (!projectRow) return

    const now = Date.now()

    // 3. Extract GitHub info from git remote
    const info = await extractGithubInfo(projectRow.path)
    if (!info) {
      db.prepare(
        `UPDATE projects
         SET github_owner = NULL, github_repo = NULL, github_avatar_url = NULL, github_checked_at = ?
         WHERE id = ?`
      ).run(now, projectId)
      broadcastGithubUpdate({
        projectId,
        githubOwner: null,
        githubRepo: null,
        githubAvatarUrl: null,
        githubCheckedAt: now
      })
      return
    }

    // 4. Fetch avatar URL
    const avatarUrl = await fetchAvatarUrl(info.owner)

    // 5. Write all four columns
    db.prepare(
      `UPDATE projects
       SET github_owner = ?, github_repo = ?, github_avatar_url = ?, github_checked_at = ?
       WHERE id = ?`
    ).run(info.owner, info.repo, avatarUrl, now, projectId)
    broadcastGithubUpdate({
      projectId,
      githubOwner: info.owner,
      githubRepo: info.repo,
      githubAvatarUrl: avatarUrl,
      githubCheckedAt: now
    })
  } catch (err) {
    console.warn('[github] refreshGithubData failed for', projectId, err)
  }
}
