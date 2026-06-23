import { createRequire } from 'module'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { app } from 'electron'
import { composeClaudeLaunch } from '../claudeSettings'
import { getClaudeAuthEnv } from '../claudeAuth'
import { getWorkspace } from '../workspaces'
import { logDiagMain } from '../diagnostics'
import type { TerminalEngine, PhaseKind } from './engine'

const _require = createRequire(import.meta.url)
const nodePty = _require('@lydell/node-pty') as typeof import('@lydell/node-pty')

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const BATCH_SIZE_LIMIT = 16 * 1024 // 16 KB
const BATCH_TIMER_MS = 5
const FLOW_HIGH_WATERMARK = 100_000
const FLOW_LOW_WATERMARK = 5_000
const STALL_TIMEOUT_MS = 10_000
const LIVENESS_INTERVAL_MS = 5_000

type PtyEntry = {
  pty: import('@lydell/node-pty').IPty
  phase: 'live' | 'dead'
  // batching
  batchBuf: string
  batchTimer: NodeJS.Timeout | null
  // flow control
  sentChars: number
  ackedChars: number
  paused: boolean
  // stall watchdog
  stallTimer: NodeJS.Timeout | null
  stallFired: boolean
  // liveness (U8)
  lastDataTs: number
}

export class XtermEngine implements TerminalEngine {
  private map = new Map<string, PtyEntry>()
  private dataHandler: ((workspaceId: string, data: string) => void) | null = null
  private exitHandler: ((workspaceId: string, exitCode: number, signal?: number) => void) | null =
    null
  private recoverHandler: ((workspaceId: string) => void) | null = null
  private livenessInterval: NodeJS.Timeout | null = null

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
        const e = this.map.get(params.workspaceId)
        if (!e) return
        e.lastDataTs = Date.now()
        e.batchBuf += data
        if (e.batchBuf.length >= BATCH_SIZE_LIMIT) {
          this.flush(params.workspaceId)
        } else if (!e.batchTimer) {
          e.batchTimer = setTimeout(() => this.flush(params.workspaceId), BATCH_TIMER_MS)
        }
      })

      pty.onExit(({ exitCode, signal }) => {
        const entry = this.map.get(params.workspaceId)
        if (entry) {
          entry.phase = 'dead'
        }
        this.exitHandler?.(params.workspaceId, exitCode, signal)
      })

      this.map.set(params.workspaceId, {
        pty,
        phase: 'live',
        batchBuf: '',
        batchTimer: null,
        sentChars: 0,
        ackedChars: 0,
        paused: false,
        stallTimer: null,
        stallFired: false,
        lastDataTs: Date.now()
      })
      this.ensureLivenessInterval()

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
    if (entry.batchTimer) {
      clearTimeout(entry.batchTimer)
      entry.batchTimer = null
    }
    if (entry.stallTimer) {
      clearTimeout(entry.stallTimer)
      entry.stallTimer = null
    }
    this.map.delete(workspaceId) // DELETE FIRST before killing
    if (this.map.size === 0) {
      this.stopLivenessInterval()
    }
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

  private flush(workspaceId: string): void {
    const entry = this.map.get(workspaceId)
    if (!entry || !entry.batchBuf) return
    if (entry.batchTimer) {
      clearTimeout(entry.batchTimer)
      entry.batchTimer = null
    }
    const data = entry.batchBuf
    entry.batchBuf = ''
    entry.sentChars += data.length
    this.dataHandler?.(workspaceId, data)
    // flow control
    const unacked = entry.sentChars - entry.ackedChars
    if (!entry.paused && unacked > FLOW_HIGH_WATERMARK) {
      entry.pty.pause()
      entry.paused = true
      this.startStallWatchdog(workspaceId)
    }
  }

  private startStallWatchdog(workspaceId: string): void {
    const entry = this.map.get(workspaceId)
    if (!entry || entry.stallTimer || entry.stallFired) return
    const unackedAtStart = entry.sentChars - entry.ackedChars
    entry.stallTimer = setTimeout(() => {
      const e = this.map.get(workspaceId)
      if (!e) return
      e.stallTimer = null
      if (!e.paused) return
      const currentUnacked = e.sentChars - e.ackedChars
      if (currentUnacked >= unackedAtStart) {
        // no progress — fire recovery
        e.stallFired = true
        logDiagMain({
          category: 'anomaly',
          level: 'warn',
          event: 'terminal.xterm_flow_stall',
          workspaceId,
          message: `xterm flow stall: unacked=${currentUnacked} for >10s`,
          data: { unacked: currentUnacked, sentChars: e.sentChars, ackedChars: e.ackedChars }
        })
        this.recoverHandler?.(workspaceId)
      }
    }, STALL_TIMEOUT_MS)
  }

  private ensureLivenessInterval(): void {
    if (this.livenessInterval) return
    this.livenessInterval = setInterval(() => {
      const now = Date.now()
      for (const [workspaceId, e] of this.map) {
        if (e.phase !== 'live') continue
        // Only flag stalls that the flow watchdog hasn't already caught:
        // stallFired means it already triggered recovery via startStallWatchdog.
        // The liveness interval is a belt-and-suspenders check for the case where
        // the PTY is paused and data stopped but stallFired was never set.
        if (e.paused && !e.stallFired && now - e.lastDataTs > STALL_TIMEOUT_MS) {
          e.stallFired = true
          logDiagMain({
            category: 'anomaly',
            level: 'warn',
            event: 'terminal.xterm_flow_stall',
            workspaceId,
            message: `xterm liveness stall: paused with no data for >${STALL_TIMEOUT_MS}ms`,
            data: { lastDataTs: e.lastDataTs, sentChars: e.sentChars, ackedChars: e.ackedChars }
          })
          this.recoverHandler?.(workspaceId)
        }
      }
    }, LIVENESS_INTERVAL_MS)
  }

  private stopLivenessInterval(): void {
    if (this.livenessInterval) {
      clearInterval(this.livenessInterval)
      this.livenessInterval = null
    }
  }

  ackChars(workspaceId: string, count: number): void {
    const entry = this.map.get(workspaceId)
    if (!entry) return
    entry.ackedChars += count
    if (entry.stallTimer) {
      clearTimeout(entry.stallTimer)
      entry.stallTimer = null
      entry.stallFired = false
    }
    if (entry.paused) {
      const unacked = entry.sentChars - entry.ackedChars
      if (unacked <= FLOW_LOW_WATERMARK) {
        entry.pty.resume()
        entry.paused = false
      } else {
        // still paused — restart stall watchdog from new baseline
        this.startStallWatchdog(workspaceId)
      }
    }
  }

  resetFlow(workspaceId: string): void {
    const entry = this.map.get(workspaceId)
    if (!entry) return
    if (entry.stallTimer) {
      clearTimeout(entry.stallTimer)
      entry.stallTimer = null
    }
    entry.stallFired = false
    const wasPaused = entry.paused
    entry.sentChars = 0
    entry.ackedChars = 0
    entry.paused = false
    if (wasPaused) {
      entry.pty.resume()
    }
  }

  killAll(): void {
    this.stopLivenessInterval()
    for (const [workspaceId, entry] of this.map) {
      try {
        if (entry.batchTimer) clearTimeout(entry.batchTimer)
        if (entry.stallTimer) clearTimeout(entry.stallTimer)
        entry.pty.kill('SIGHUP')
      } catch {
        // ignore — process may already be dead
      }
      console.log('[xterm] killAll: killed workspaceId=%s', workspaceId)
    }
    this.map.clear()
  }

  getLivePids(): number[] {
    const pids: number[] = []
    for (const entry of this.map.values()) {
      if (entry.phase === 'live') {
        try {
          pids.push(entry.pty.pid)
        } catch {
          // ignore
        }
      }
    }
    return pids
  }

  setDataHandler(handler: (workspaceId: string, data: string) => void): void {
    this.dataHandler = handler
  }

  setExitHandler(handler: (workspaceId: string, exitCode: number, signal?: number) => void): void {
    this.exitHandler = handler
  }

  setRecoverHandler(handler: (workspaceId: string) => void): void {
    this.recoverHandler = handler
  }
}
