import { createHash } from 'node:crypto'

const SECRET_KEY =
  /(?:token|secret|password|authorization|cookie|lease|credential|api[_-]?key|access[_-]?key|private[_-]?key|environment|env|bytes|sequence|keycode)/i
const TEXT_KEY = /(?:^|_)(?:text|task|prompt|content|input)(?:$|_)/i
const SECRET_VALUE =
  /(?:\bbearer\s+\S+|(?:api[_-]?key|token|secret|password|authorization|cookie|lease)\s*[:=]\s*\S+|\bsk[-_](?:ant[-_])?[A-Za-z0-9_-]+|\bgh[pousr]_[A-Za-z0-9_]+|\bgithub_pat_[A-Za-z0-9_]+|\bxox[aboprs]-[A-Za-z0-9-]+)/i
const MAX_SAFE_STRING = 512

function textMetadata(value: string): Record<string, unknown> {
  const byteLength = Buffer.byteLength(value, 'utf8')
  return {
    sha256: createHash('sha256').update(value, 'utf8').digest('hex'),
    byteLength,
    summary: `[text ${byteLength} bytes]`
  }
}

function redactValue(value: unknown, key: string | null, seen: WeakSet<object>): unknown {
  if (key != null && SECRET_KEY.test(key)) return '[REDACTED]'
  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value)) return '[REDACTED]'
    if (key != null && TEXT_KEY.test(key)) return textMetadata(value)
    if (SECRET_VALUE.test(value)) return '[REDACTED]'
    return value.length <= MAX_SAFE_STRING ? value : `${value.slice(0, MAX_SAFE_STRING)}…`
  }
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'object') return `[${typeof value}]`
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, key, seen))
  }
  const result: Record<string, unknown> = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    result[childKey] = redactValue(childValue, childKey, seen)
  }
  return result
}

export function recursivelyRedact(value: unknown): Record<string, unknown> {
  const redacted = redactValue(value, null, new WeakSet())
  return redacted != null && typeof redacted === 'object' && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : { value: redacted }
}
