// ---------------------------------------------------------------------------
// src/main/ipc/system.ts
//
// System/diagnostics IPC — moved verbatim out of index.ts (STR-1).
//
// NOTE: doctor:check is deliberately NOT here. It depends on checkClaude(),
// a private index.ts function whose cache (cachedClaudeCheck) is invalidated
// by a mainWindow 'focus' listener inside createWindow() — genuine index.ts
// state, not a clean self-contained handler. Left in index.ts.
// ---------------------------------------------------------------------------

import { app, Notification } from 'electron'
import { dialog } from 'electron'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { HealthReport, AppUiState, DiagRow } from '../../shared/types'
import { getLiveSessionState } from '../sessionState'
import { countManagedHooks } from '../orpheusNotify'
import { getUserShellPath } from '../shellHelpers'
import { openDiagConsole } from '../diagConsoleWindow'
import { queryDiagnostics } from '../diagnostics'
import { formatTraceTree, formatEventLine } from '../../shared/diagFormat'
import { handle } from './handle'

export interface SystemIpcDeps {
  getAppUiState: () => AppUiState
}

export function registerSystemIpc(deps: SystemIpcDeps): void {
  // ---------------------------------------------------------------------------
  // Health IPC
  // ---------------------------------------------------------------------------

  handle('health:get', async (): Promise<HealthReport> => {
    // claudeCli
    let claudeCli: HealthReport['claudeCli']
    try {
      const userPath = await getUserShellPath()
      const whichResult = await new Promise<string>((resolve, reject) => {
        childProcess.exec(
          'which claude',
          { env: { ...process.env, PATH: userPath } },
          (err, stdout) => {
            if (err) reject(err instanceof Error ? err : new Error('which claude failed'))
            else resolve(stdout.trim())
          }
        )
      })
      if (!whichResult) throw new Error('claude not found on PATH')
      const version = await new Promise<string>((resolve, reject) => {
        const child = childProcess.spawn(whichResult, ['--version'], {
          env: { ...process.env, PATH: userPath },
          timeout: 5000
        })
        let out = ''
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString()
        })
        child.stderr.on('data', (d: Buffer) => {
          out += d.toString()
        })
        child.on('close', (code) => {
          if (code === 0) resolve(out.trim())
          else reject(new Error(`exit ${code}`))
        })
        child.on('error', reject)
      })
      claudeCli = { status: 'ok', detail: version }
    } catch {
      claudeCli = { status: 'error', detail: 'claude not found on PATH' }
    }

    // sessionRegistry
    let sessionRegistry: HealthReport['sessionRegistry']
    try {
      const sessionDir = path.join(os.homedir(), '.claude', 'sessions')
      await fs.promises.access(sessionDir, fs.constants.R_OK)
      const liveCount = getLiveSessionState().size
      sessionRegistry = { status: 'ok', detail: `${liveCount} live session(s)` }
    } catch {
      sessionRegistry = { status: 'warn', detail: 'session directory not found' }
    }

    // notifications
    const notifSupported = Notification.isSupported()
    const notifications: HealthReport['notifications'] = notifSupported
      ? { status: 'ok', detail: 'Supported' }
      : { status: 'warn', detail: 'Not supported on this platform' }

    // hooks
    const hooksEnabled = deps.getAppUiState().hooksIntegrationEnabled
    const hooksInstalled = countManagedHooks()
    const hooksDetail = hooksEnabled ? `enabled · ${hooksInstalled} installed` : 'disabled'
    const hooks: HealthReport['hooks'] = {
      status: 'ok',
      detail: hooksDetail,
      enabled: hooksEnabled,
      installed: hooksInstalled
    }

    // dataDir
    let dataDir: HealthReport['dataDir']
    try {
      await fs.promises.access(app.getPath('userData'), fs.constants.W_OK)
      dataDir = { status: 'ok', detail: 'Writable' }
    } catch {
      dataDir = { status: 'error', detail: 'Not writable' }
    }

    return { claudeCli, sessionRegistry, notifications, hooks, dataDir }
  })

  // ---------------------------------------------------------------------------
  // Diagnostics IPC (console window + export; the diag:event push listener
  // and ingestDiagEvent wiring stay in index.ts alongside diagnostics startup)
  // ---------------------------------------------------------------------------

  handle('diag:openConsole', () => {
    openDiagConsole()
  })

  handle('diag:export', async (_e, { sinceMs }) => {
    try {
      const result = await dialog.showSaveDialog({
        title: 'Export Diagnostics',
        defaultPath: 'orpheus-diagnostics.txt',
        filters: [{ name: 'Text', extensions: ['txt'] }]
      })

      if (result.canceled || !result.filePath) {
        return { ok: false, error: 'canceled' }
      }

      const txtPath = result.filePath
      const { dir, name } = path.parse(txtPath)
      const jsonPath = path.join(dir, name + '.json')

      const rows = queryDiagnostics({ sinceMs, limit: 100_000 })
      const txtContent = buildDiagReportText(rows, sinceMs)

      const writeResult = writeDiagReportFiles(txtPath, jsonPath, txtContent, rows)
      if (!writeResult.ok) return writeResult

      return { ok: true, path: txtPath, txtPath, jsonPath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

/** Build the readable .txt diagnostics report body: header, trace trees, flat events. */
function buildDiagReportText(rows: DiagRow[], sinceMs: number): string {
  const exportedAt = new Date().toISOString()
  const rangeStart = new Date(sinceMs).toISOString()
  const lines: string[] = [
    `Orpheus Diagnostics Export`,
    `Exported: ${exportedAt}`,
    `Range: ${rangeStart} — ${exportedAt}`,
    `Rows: ${rows.length}`,
    '',
    '═'.repeat(72),
    ''
  ]

  // Group rows by traceId
  const traceRows = new Map<string, DiagRow[]>()
  const nonTraceRows: DiagRow[] = []
  for (const row of rows) {
    if (row.traceId) {
      if (!traceRows.has(row.traceId)) traceRows.set(row.traceId, [])
      traceRows.get(row.traceId)!.push(row)
    } else {
      nonTraceRows.push(row)
    }
  }

  // Trace trees section
  if (traceRows.size > 0) {
    lines.push('TRACES', '─'.repeat(72), '')
    for (const [traceId, tRows] of traceRows) {
      lines.push(`Trace: ${traceId}`)
      lines.push(formatTraceTree(tRows))
      lines.push('')
    }
  }

  // Flat events section
  if (nonTraceRows.length > 0) {
    lines.push('EVENTS', '─'.repeat(72), '')
    for (const row of nonTraceRows) {
      lines.push(formatEventLine(row))
    }
    lines.push('')
  }

  return lines.join('\n')
}

/** Write the .txt report then the .json sidecar. If the JSON write fails after the
 *  txt landed, removes the orphaned txt so a half-completed report is never left behind. */
function writeDiagReportFiles(
  txtPath: string,
  jsonPath: string,
  txtContent: string,
  rows: DiagRow[]
): { ok: true } | { ok: false; error: string } {
  fs.writeFileSync(txtPath, txtContent, 'utf8')
  try {
    fs.writeFileSync(jsonPath, JSON.stringify(rows, null, 2), 'utf8')
  } catch (jsonErr) {
    try {
      fs.unlinkSync(txtPath)
    } catch {
      /* best-effort cleanup */
    }
    return {
      ok: false,
      error: `Report could not be completed (JSON sidecar failed): ${
        jsonErr instanceof Error ? jsonErr.message : String(jsonErr)
      }`
    }
  }
  return { ok: true }
}
