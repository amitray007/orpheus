import type { DiagCategory, DiagEvent, DiagLevel, DiagProcess, DiagRow } from '../shared/types'
import { redactLogRecord, redactLogString, redactLogValue } from './logRedaction'

const DIAG_CATEGORIES = new Set<DiagCategory>(['error', 'lifecycle', 'perf', 'anomaly', 'trace'])
const DIAG_LEVELS = new Set<DiagLevel>(['debug', 'info', 'warn', 'error', 'fatal'])
const DIAG_PROCESSES = new Set<DiagProcess>(['main', 'renderer', 'native'])
const DIAG_KINDS = new Set<NonNullable<DiagEvent['kind']>>(['span', 'event', 'mark'])

function safeParse(s: string): Record<string, unknown> | null {
  try {
    if (s.length > 256 * 1_024) return { value: '[BUDGET_EXCEEDED]' }
    const parsed: unknown = JSON.parse(s)
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? redactLogRecord(parsed as Record<string, unknown>)
      : { value: redactLogValue(parsed) }
  } catch {
    return { value: redactLogString(s) }
  }
}

function finiteInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

function safeOptionalString(value: unknown, maxLength = 8_192): string | null {
  return typeof value === 'string' ? redactLogString(value).slice(0, maxLength) : null
}

export function sanitizeDiagnosticRowForOutput(input: unknown): DiagRow | null {
  try {
    const normalized = redactLogValue(input)
    if (normalized == null || typeof normalized !== 'object' || Array.isArray(normalized))
      return null
    const row = normalized as Record<string, unknown>
    const id = finiteInteger(row['id'])
    const ts = finiteInteger(row['ts'])
    const seq = finiteInteger(row['seq'])
    const processName = row['process']
    const category = row['category']
    const level = row['level']
    const event = safeOptionalString(row['event'], 160)
    if (
      id == null ||
      ts == null ||
      seq == null ||
      typeof processName !== 'string' ||
      !DIAG_PROCESSES.has(processName as DiagProcess) ||
      typeof category !== 'string' ||
      !DIAG_CATEGORIES.has(category as DiagCategory) ||
      typeof level !== 'string' ||
      !DIAG_LEVELS.has(level as DiagLevel) ||
      event == null ||
      event.length === 0
    ) {
      return null
    }
    const rawData = row['data']
    const data =
      typeof rawData === 'string'
        ? safeParse(rawData)
        : rawData != null && typeof rawData === 'object' && !Array.isArray(rawData)
          ? redactLogRecord(rawData as Record<string, unknown>)
          : null
    const kind = row['kind']
    return {
      id,
      ts,
      seq,
      process: processName as DiagProcess,
      category: category as DiagCategory,
      level: level as DiagLevel,
      event,
      workspaceId: safeOptionalString(row['workspaceId'], 256),
      sessionId: safeOptionalString(row['sessionId'], 256),
      durationMs: finiteInteger(row['durationMs']),
      message: safeOptionalString(row['message']) ?? undefined,
      data,
      traceId: safeOptionalString(row['traceId'], 256),
      spanId: safeOptionalString(row['spanId'], 256),
      parentSpanId: safeOptionalString(row['parentSpanId'], 256),
      name: safeOptionalString(row['name'], 160),
      kind:
        typeof kind === 'string' && DIAG_KINDS.has(kind as NonNullable<DiagEvent['kind']>)
          ? (kind as NonNullable<DiagEvent['kind']>)
          : null
    }
  } catch {
    return null
  }
}

export function sanitizeDiagnosticRowsForOutput(rows: readonly unknown[]): DiagRow[] {
  return rows
    .map((row) => sanitizeDiagnosticRowForOutput(row))
    .filter((row): row is DiagRow => row != null)
}
