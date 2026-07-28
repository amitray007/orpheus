import { createHash, type Hash } from 'node:crypto'
import { AUTOMATION_LIMITS } from './types'

const SECRET_KEY =
  /(?:token|secret|password|authorization|cookie|lease|credential|api[_-]?key|access[_-]?key|private[_-]?key|environment|env|bytes|sequence|keycode)/i
const TEXT_KEY = /(?:(?:^|_)(?:text|task|prompt|content|input)(?:$|_)|command$)/i
const SECRET_VALUE =
  /(?:\bbearer\s+\S+|(?:api[_-]?key|token|secret|password|authorization|cookie|lease)\s*[:=]\s*\S+|\bsk[-_](?:ant[-_])?[A-Za-z0-9_-]+|\bgh[pousr]_[A-Za-z0-9_]+|\bgithub_pat_[A-Za-z0-9_]+|\bxox[aboprs]-[A-Za-z0-9-]+)/i

const MAX_DEPTH = 16
const MAX_NODES = 512
const MAX_CONTAINER_ITEMS = 128
const MAX_KEY_CHARS = 256
const MAX_SAFE_STRING_CHARS = 512
const MIN_PERSISTED_VALUE_BYTES = 512
const TRUNCATION_REASON = 'persisted_result_safety_limit'

export type PersistedAutomationResult = Record<string, unknown>

type TraversalState = {
  readonly seen: WeakSet<object>
  readonly fingerprint: Hash
  readonly maxCopiedChars: number
  nodes: number
  copiedChars: number
  maxObservedDepth: number
  stoppedBy: string | null
}

function fingerprint(state: TraversalState, token: string): void {
  state.fingerprint.update(`${token.length}:`)
  state.fingerprint.update(token)
}

function stop(state: TraversalState, reason: string, metadata = ''): void {
  if (state.stoppedBy != null) return
  state.stoppedBy = reason
  fingerprint(state, `stopped:${reason}:${metadata}`)
}

function consumeChars(state: TraversalState, count: number): boolean {
  if (count > state.maxCopiedChars - state.copiedChars) {
    stop(state, 'copied_character_limit', String(count))
    return false
  }
  state.copiedChars += count
  return true
}

function safeTextMetadata(value: string): Record<string, unknown> {
  const byteLength = Buffer.byteLength(value, 'utf8')
  return {
    sha256: createHash('sha256').update(value, 'utf8').digest('hex'),
    byteLength,
    summary: `[text ${byteLength} bytes]`
  }
}

function dataProperty(object: object, key: PropertyKey, state: TraversalState): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    if (descriptor == null) return undefined
    if (!Object.hasOwn(descriptor, 'value')) {
      stop(state, 'accessor_property')
      return undefined
    }
    return (descriptor as { value: unknown }).value
  } catch {
    stop(state, 'property_descriptor_failure')
    return undefined
  }
}

function arrayKind(value: object, state: TraversalState): boolean | null {
  try {
    return Array.isArray(value)
  } catch {
    stop(state, 'array_detection_failure')
    return null
  }
}

function redactString(
  value: string,
  key: string | null,
  state: TraversalState
): string | Record<string, unknown> | null {
  if (value.length > MAX_SAFE_STRING_CHARS) {
    stop(state, 'string_length_limit', String(value.length))
    return null
  }
  if (!consumeChars(state, value.length)) return null
  if (SECRET_VALUE.test(value)) {
    fingerprint(state, 'string:[REDACTED]')
    return '[REDACTED]'
  }
  if (key != null && TEXT_KEY.test(key)) {
    fingerprint(state, `text:${value}`)
    return safeTextMetadata(value)
  }
  fingerprint(state, `string:${value}`)
  return value
}

function redactArray(
  value: readonly unknown[],
  state: TraversalState,
  depth: number
): unknown[] | null {
  const length = dataProperty(value, 'length', state)
  if (state.stoppedBy != null) return null
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    stop(state, 'invalid_array_length')
    return null
  }
  if (length > MAX_CONTAINER_ITEMS) {
    stop(state, 'container_item_limit', String(length))
    return null
  }
  const redacted = new Array<unknown>(length)
  for (let index = 0; index < length; index++) {
    const item = dataProperty(value, String(index), state)
    if (state.stoppedBy != null) return null
    const child = boundedRedact(item, null, state, depth + 1)
    if (state.stoppedBy != null) return null
    redacted[index] = child
  }
  return redacted
}

function redactObject(
  value: object,
  state: TraversalState,
  depth: number
): Record<string, unknown> | null {
  try {
    const prototype = Object.getPrototypeOf(value) as unknown
    if (prototype !== Object.prototype && prototype !== null) {
      stop(state, 'unsupported_object_prototype')
      return null
    }
  } catch {
    stop(state, 'object_prototype_failure')
    return null
  }

  const redacted: Record<string, unknown> = {}
  let count = 0
  try {
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue
      count++
      if (count > MAX_CONTAINER_ITEMS) {
        stop(state, 'container_item_limit', String(count))
        return null
      }
      if (key.length > MAX_KEY_CHARS || !consumeChars(state, key.length)) {
        stop(state, 'key_length_limit', String(key.length))
        return null
      }
      if (SECRET_VALUE.test(key)) {
        fingerprint(state, 'key:[REDACTED]')
        stop(state, 'secret_bearing_key')
        return null
      }
      if (SECRET_KEY.test(key)) {
        fingerprint(state, 'key:[REDACTED]')
        redacted[key] = '[REDACTED]'
        continue
      }
      fingerprint(state, `key:${key}`)
      const child = dataProperty(value, key, state)
      if (state.stoppedBy != null) return null
      redacted[key] = boundedRedact(child, key, state, depth + 1)
      if (state.stoppedBy != null) return null
    }
  } catch {
    stop(state, 'property_enumeration_failure')
    return null
  }
  return redacted
}

function boundedRedact(
  value: unknown,
  key: string | null,
  state: TraversalState,
  depth: number
): unknown {
  state.maxObservedDepth = Math.max(state.maxObservedDepth, depth)
  if (depth > MAX_DEPTH) {
    stop(state, 'depth_limit', String(depth))
    return null
  }
  state.nodes++
  if (state.nodes > MAX_NODES) {
    stop(state, 'node_limit', String(state.nodes))
    return null
  }
  if (key != null && SECRET_KEY.test(key)) {
    fingerprint(state, 'value:[REDACTED]')
    return '[REDACTED]'
  }
  if (typeof value === 'string') return redactString(value, key, state)
  if (value == null || typeof value === 'boolean') {
    fingerprint(state, `${typeof value}:${String(value)}`)
    return value
  }
  if (typeof value === 'number') {
    const normalized = Number.isFinite(value) ? value : null
    fingerprint(state, `number:${String(normalized)}`)
    return normalized
  }
  if (typeof value === 'bigint') {
    fingerprint(state, 'bigint')
    return '[bigint]'
  }
  if (typeof value !== 'object') {
    const marker = `[${typeof value}]`
    fingerprint(state, marker)
    return marker
  }
  const isArray = arrayKind(value, state)
  if (isArray == null) return null
  if (state.seen.has(value)) {
    fingerprint(state, '[CIRCULAR]')
    return '[CIRCULAR]'
  }
  state.seen.add(value)
  fingerprint(state, isArray ? 'array' : 'object')
  return isArray
    ? redactArray(value as readonly unknown[], state, depth)
    : redactObject(value, state, depth)
}

function truncationReceipt(state: TraversalState, maxBytes: number): Record<string, unknown> {
  return {
    truncated: true,
    reason: TRUNCATION_REASON,
    stoppedBy: state.stoppedBy ?? 'serialized_byte_limit',
    maxBytes,
    inspectedNodes: Math.min(state.nodes, MAX_NODES),
    maxObservedDepth: Math.min(state.maxObservedDepth, MAX_DEPTH + 1),
    sha256: state.fingerprint.digest('hex')
  }
}

/**
 * Redact while traversing within fixed work bounds. No accessor is invoked and
 * no oversized string, array, object, or BigInt is copied/stringified/hashed in
 * full. Unsafe or oversized values collapse to a metadata-only receipt.
 */
export function persistableAutomationValue(
  value: unknown,
  requestedMaxBytes = AUTOMATION_LIMITS.maxPersistedResultBytes
): unknown {
  const maxBytes = Math.max(
    MIN_PERSISTED_VALUE_BYTES,
    Math.min(AUTOMATION_LIMITS.maxPersistedResultBytes, Math.floor(requestedMaxBytes))
  )
  const state: TraversalState = {
    seen: new WeakSet(),
    fingerprint: createHash('sha256'),
    maxCopiedChars: maxBytes,
    nodes: 0,
    copiedChars: 0,
    maxObservedDepth: 0,
    stoppedBy: null
  }
  const redacted = boundedRedact(value, null, state, 0)
  if (state.stoppedBy != null) return truncationReceipt(state, maxBytes)

  try {
    const serialized = JSON.stringify(redacted)
    if (serialized !== undefined && Buffer.byteLength(serialized, 'utf8') <= maxBytes) {
      return redacted
    }
  } catch {
    stop(state, 'serialization_failure')
  }
  return truncationReceipt(state, maxBytes)
}

export function persistableAutomationResult(
  result: unknown,
  maxBytes = AUTOMATION_LIMITS.maxPersistedResultBytes
): PersistedAutomationResult {
  const wrapperBytes = Buffer.byteLength(JSON.stringify({ value: null }), 'utf8') - 4
  return {
    value: persistableAutomationValue(result, maxBytes - wrapperBytes)
  }
}
