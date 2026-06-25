import type { DiagCategory, DiagLevel } from '@shared/types'
import { DIAG_EVENTS } from '@shared/diagEvents'
import { newTraceId, newSpanId, serializeContext } from '@shared/trace'
import type { TraceContext } from '@shared/trace'

export function logDiag(partial: {
  category: DiagCategory
  level: DiagLevel
  event: string
  workspaceId?: string | null
  sessionId?: string | null
  durationMs?: number | null
  message?: string
  data?: Record<string, unknown> | null
  traceId?: string | null
  spanId?: string | null
  parentSpanId?: string | null
  name?: string | null
  kind?: 'span' | 'event' | 'mark' | null
}): void {
  try {
    window.api.diag.event({ ts: Date.now(), process: 'renderer', ...partial })
  } catch {
    /* never throw */
  }
}

let current: TraceContext | undefined

export const diag = {
  // Renderer spans use EXPLICIT context (no AsyncLocalStorage in Chromium).
  // Emits a single completed-span record on resolution.
  async trace<T>(
    name: string,
    attrs: Record<string, unknown> | undefined,
    fn: () => Promise<T> | T
  ): Promise<T> {
    const ctx: TraceContext = {
      traceId: current?.traceId ?? newTraceId(),
      spanId: newSpanId()
    }
    const parentSpanId = current?.spanId ?? null
    const start = Date.now()
    const prev = current
    current = ctx
    try {
      return await fn()
    } finally {
      current = prev
      logDiag({
        category: 'trace',
        level: 'info',
        event: name,
        name,
        kind: 'span',
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        parentSpanId,
        durationMs: Date.now() - start,
        data: attrs ?? null,
        workspaceId: typeof attrs?.workspaceId === 'string' ? attrs.workspaceId : null
      })
    }
  },
  event(name: string, attrs?: Record<string, unknown>): void {
    logDiag({
      category: 'trace',
      level: 'info',
      event: name,
      name,
      kind: 'event',
      traceId: current?.traceId ?? newTraceId(),
      spanId: current?.spanId ?? newSpanId(),
      data: attrs ?? null
    })
  },
  currentContext(): TraceContext | undefined {
    return current
  },
  // Serialize the active context to thread into an IPC payload (e.g. _trace).
  serializeCurrent(): string | undefined {
    return current ? serializeContext(current) : undefined
  },
  withContext<T>(ctx: TraceContext, fn: () => T): T {
    const prev = current
    current = ctx
    try {
      return fn()
    } finally {
      current = prev
    }
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
