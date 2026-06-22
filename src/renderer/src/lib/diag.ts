import type { DiagCategory, DiagLevel } from '@shared/types'
import { DIAG_EVENTS } from '@shared/diagEvents'

export function logDiag(partial: {
  category: DiagCategory
  level: DiagLevel
  event: string
  workspaceId?: string | null
  sessionId?: string | null
  durationMs?: number | null
  message?: string
  data?: Record<string, unknown> | null
}): void {
  try {
    window.api.diag.event({ ts: Date.now(), process: 'renderer', ...partial })
  } catch {
    /* never throw */
  }
}

let installed = false
export function installRendererErrorCapture(): void {
  if (installed) return
  installed = true
  window.addEventListener('error', (e) => {
    logDiag({
      category: 'error',
      level: 'error',
      event: DIAG_EVENTS.ERROR_RENDERER,
      message: e.message,
      data: {
        filename: e.filename,
        lineno: e.lineno,
        colno: e.colno,
        stack: e.error?.stack ?? null
      }
    })
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string; stack?: string }
    logDiag({
      category: 'error',
      level: 'error',
      event: DIAG_EVENTS.ERROR_RENDERER,
      message: r?.message ?? String(e.reason),
      data: { stack: r?.stack ?? null, kind: 'unhandledrejection' }
    })
  })
}
