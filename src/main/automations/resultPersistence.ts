import { createHash } from 'node:crypto'
import { recursivelyRedact } from '../workspaceOrchestration/redaction'
import { AUTOMATION_LIMITS } from './types'

const TRUNCATION_REASON = 'persisted_result_byte_limit'

export type PersistedAutomationResult = Record<string, unknown>

/**
 * Redact before measuring so the persisted byte budget describes the exact
 * payload SQLite would otherwise retain. Oversized values become a stable
 * metadata receipt rather than being sliced into invalid JSON or silently
 * dropped.
 */
export function persistableAutomationResult(result: unknown): PersistedAutomationResult {
  const redacted = recursivelyRedact({ value: result })
  const serialized = JSON.stringify(redacted)
  const byteLength = Buffer.byteLength(serialized, 'utf8')
  if (byteLength <= AUTOMATION_LIMITS.maxPersistedResultBytes) return redacted

  return {
    value: {
      truncated: true,
      reason: TRUNCATION_REASON,
      originalByteLength: byteLength,
      sha256: createHash('sha256').update(serialized, 'utf8').digest('hex')
    }
  }
}
