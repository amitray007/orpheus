import { createRequire } from 'module'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { app } from 'electron'
import { composeClaudeLaunch } from '../claudeSettings'
import { getClaudeAuthEnv } from '../claudeAuth'
import { getWorkspace } from '../workspaces'
import type { TerminalEngine, PhaseKind } from './engine'

const _require = createRequire(import.meta.url)
const nodePty = _require('@lydell/node-pty') as typeof import('@lydell/node-pty')

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

type PtyEntry = {
  pty: import('@lydell/node-pty').IPty
  phase: 'live' | 'dead'
}

export class XtermEngine implements TerminalEngine {
  private map = new Map<string, PtyEntry>()
  private dataHandler: ((workspaceId: string, data: string) => void) | null = null
  private exitHandler: ((workspaceId: string, exitCode: number, signal?: number) => void) | null =
    null

  spawn(params: {
    workspaceId: string
    cwd: string
    cols?: number
    rows?: number
    notifySockPath?: string
    notifyShimPath?: string
    userPath?: string
  }): { created: boolean; error?: string } {
    const existing = this.map.get(params.workspaceId)
    if (existing?.phase === 'live') {
      return { created: false }
    }

    const ws = getWorkspace(params.workspaceId)
    const projectId = ws?.projectId
    const launch = composeClaudeLaunch(projectId, params.workspaceId)
    const authEnv = getClaudeAuthEnv() // NEVER log values

    const ptyEnv: Record<string, string> = {
      ...launch.env,
      ...authEnv,
      ...(launch.flags ? { ORPHEUS_CLAUDE_FLAGS: launch.flags } : {}),
      ...(launch.settingsJson ? { ORPHEUS_CLAUDE_SETTINGS_JSON: launch.settingsJson } : {}),
      ORPHEUS_WORKSPACE_ID: params.workspaceId,
      ...(params.notifySockPath ? { ORPHEUS_SOCK: params.notifySockPath } : {}),
      ...(params.notifyShimPath ? { ORPHEUS_NOTIFY: params.notifyShimPath } : {}),
      ...(params.userPath ? { ORPHEUS_USER_PATH: params.userPath } : {}),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    }

    const shellScript = app.isPackaged
      ? join(process.resourcesPath, 'orpheus-claude.sh')
      : join(__dirname, '../../resources/orpheus-claude.sh')

    try {
      const pty = nodePty.spawn(shellScript, [], {
        name: 'xterm-256color',
        cols: params.cols ?? 80,
        rows: params.rows ?? 24,
        cwd: params.cwd,
        env: { ...process.env, ...ptyEnv } as Record<string, string>,
        encoding: 'utf8'
      })

      pty.onData((data) => {
        if (this.map.has(params.workspaceId)) {
          this.dataHandler?.(params.workspaceId, data)
        }
      })

      pty.onExit(({ exitCode, signal }) => {
        const entry = this.map.get(params.workspaceId)
        if (entry) {
          entry.phase = 'dead'
        }
        this.exitHandler?.(params.workspaceId, exitCode, signal)
      })

      this.map.set(params.workspaceId, { pty, phase: 'live' })

      console.log(
        '[xterm] spawn workspaceId=%s cwd=%s envKeys=%s',
        params.workspaceId,
        params.cwd,
        Object.keys(ptyEnv).join(',')
      )

      return { created: true }
    } catch (err) {
      return { created: false, error: String(err) }
    }
  }

  destroy(workspaceId: string): void {
    const entry = this.map.get(workspaceId)
    if (!entry) return
    this.map.delete(workspaceId) // DELETE FIRST before killing
    try {
      entry.pty.kill('SIGHUP')
    } catch {
      // ignore
    }
    console.log('[xterm] destroy workspaceId=%s', workspaceId)
  }

  write(workspaceId: string, data: string | Buffer): void {
    const entry = this.map.get(workspaceId)
    if (!entry || entry.phase !== 'live') return
    try {
      entry.pty.write(data as string)
    } catch {
      // ignore
    }
  }

  resize(workspaceId: string, cols: number, rows: number): void {
    const entry = this.map.get(workspaceId)
    if (!entry || entry.phase !== 'live') return
    try {
      entry.pty.resize(cols, rows)
    } catch {
      // ignore
    }
  }

  getPhase(workspaceId: string): PhaseKind {
    const entry = this.map.get(workspaceId)
    if (!entry) return 'none'
    return entry.phase
  }

  setDataHandler(handler: (workspaceId: string, data: string) => void): void {
    this.dataHandler = handler
  }

  setExitHandler(handler: (workspaceId: string, exitCode: number, signal?: number) => void): void {
    this.exitHandler = handler
  }
}
