import type {
  GhosttySurfaceAddon,
  ScreenTailReadResult
} from '../../../packages/ghostty-surface/index'
import type { AuthoritativeOutputProvider, OutputTailModel, TerminalObservation } from './types'

type ScreenTailReader = Pick<GhosttySurfaceAddon, 'readScreenTail'>

function unavailable(observedAt: number, reason: string): TerminalObservation<OutputTailModel> {
  return {
    value: null,
    source: 'authoritative-text-stream',
    observedAt,
    sourceUpdatedAt: null,
    freshness: 'unknown',
    availability: 'unavailable',
    reason
  }
}

function available(
  result: Extract<ScreenTailReadResult, { available: true }>,
  observedAt: number
): TerminalObservation<OutputTailModel> {
  return {
    value: {
      text: result.text,
      bytes: result.bytes,
      lines: result.lines,
      truncated: result.truncated
    },
    source: 'authoritative-text-stream',
    observedAt,
    sourceUpdatedAt: result.capturedAt,
    freshness: 'live',
    availability: 'available'
  }
}

/**
 * Bridges the native screen reader into terminal observation without
 * widening target authorization: the service resolves and scopes the exact
 * surface before this provider receives it.
 */
export function createNativeOutputProvider(
  getReader: () => ScreenTailReader | null
): AuthoritativeOutputProvider {
  return {
    readTail: (target, limits, observedAt) => {
      const reader = getReader()
      if (reader == null) {
        return unavailable(observedAt, 'The native terminal surface is unavailable.')
      }
      try {
        const result = reader.readScreenTail(target.surfaceId, limits.maxBytes, limits.maxLines)
        return result.available
          ? available(result, observedAt)
          : unavailable(observedAt, 'The requested terminal surface is unavailable.')
      } catch {
        return unavailable(observedAt, 'The native terminal screen could not be read.')
      }
    }
  }
}
