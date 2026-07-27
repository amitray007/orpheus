const REDACTED = '[REDACTED]'
const CIRCULAR = '[CIRCULAR]'
const REFERENCE = '[REFERENCE]'
const ACCESSOR = '[ACCESSOR]'
const UNINSPECTABLE = '[UNINSPECTABLE]'
const BUDGET_EXCEEDED = '[BUDGET_EXCEEDED]'
const MAX_DEPTH = 12
const MAX_INPUT_STRING_LENGTH = 65_536
const MAX_OUTPUT_STRING_LENGTH = 8_192
const MAX_PROPERTY_NAME_LENGTH = 256
const MAX_NODES = 512
const MAX_KEYS = 2_048
const MAX_ARRAY_ITEMS = 256
const MAX_BYTES = 256 * 1_024

const EXACT_SENSITIVE_KEYS = new Set([
  'authorization',
  'auth',
  'authentication',
  'key',
  'proxy-authorization',
  'x-orpheus-token',
  'x-orpheus-phase8-qa-token',
  'orpheus-cmd-token',
  'orpheus-cmd-token-file',
  'orpheus-runtime-lease-token',
  'orpheus-phase8-qa-token',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'authtoken',
  'clientsecret',
  'privatekey',
  'signingkey',
  'sessioncredential'
])
const EXACT_SAFE_METADATA_KEYS = new Set([
  'envKeys',
  'keyNames',
  'tokenCount',
  'tokenBytes',
  'tokenLength',
  'tokenPresent'
])
const SAFE_METADATA_COMPACT_KEYS = new Set(
  [...EXACT_SAFE_METADATA_KEYS].map((key) => key.replaceAll(/[-_.]/g, '').toLowerCase())
)

const SENSITIVE_KEY_PART =
  /(?:^|[-_.])(?:auth|authentication|token|secret|password|passwd|passphrase|credential|authorization|cookie|key|api[-_.]?key|access[-_.]?key|private[-_.]?key|signing[-_.]?key)(?:$|[-_.])/i
const CAMEL_CASE_SENSITIVE_KEY_PART =
  /(?:Auth|Authentication|Token|Secret|Password|Passwd|Passphrase|Credential|Authorization|Cookie|Key|ApiKey|APIKey|AccessKey|PrivateKey|SigningKey)(?:$|[A-Z0-9])/u
const CONCATENATED_SENSITIVE_KEY =
  /(?:auth|authentication|token|secret|password|passwd|passphrase|credential|authorization|cookie|apikey|accesskey|privatekey|signingkey)$/i
const SENSITIVE_IDENTIFIER_KEY =
  /(?:auth|authentication|token|secret|password|passwd|passphrase|credential|authorization|cookie|key|apikey|accesstoken|accesskey|privatekey|signingkey)(?:[-_.]?id)$/i

const ASSIGNMENT =
  /((?:["']?)([A-Za-z](?=[A-Za-z0-9_.-]*(?:auth|key|token|secret|password|passwd|passphrase|credential|authorization|cookie))[A-Za-z0-9_.-]*)(?:["']?)\s*[:=]\s*)(\[REDACTED\]|Basic\s+[^\s,}\]]+|Bearer\s+[^\s,}\]]+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[^,\n\r}\]]+)/giu
const SIMPLE_SECRET_ASSIGNMENT =
  /(\b(?:auth|authentication|key|token|secret|password|passwd|passphrase|credential|authorization|cookie)\b\s*[:=]\s*)(\[REDACTED\]|Basic\s+[^\s,}\]]+|Bearer\s+[^\s,}\]]+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[^,\n\r}\]]+)/giu
const AUTHORIZATION_VALUE = /\b(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/giu
const JWT = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu
const RECOGNIZABLE_SECRET =
  /\b(?:sk[-_](?:ant[-_]|proj[-_]|live[-_]|test[-_])?[A-Za-z0-9_-]+|rk_(?:live|test)_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+|xox[aboprs]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{30,}|ya29\.[0-9A-Za-z_-]+|npm_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,})\b/gu
const PEM_PRIVATE_KEY =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu
const URL_VALUE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/giu
const ARGV_PAIR = /(--[A-Za-z][A-Za-z0-9_.-]*)(=|\s+)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gu
const SHORT_SECRET_ARG = /(^|\s)(-[ubUcHEpPkt])(\s+|=)?("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)?/gu
const MCP_CONFIG_ARGUMENT =
  /(--mcp-config(?:=|\s+))(\{.*\}|\[.*\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/giu

type RedactionState = {
  nodes: number
  keys: number
  bytes: number
  seen: WeakSet<object>
  active: WeakSet<object>
}

type RedactionContext = {
  mcp: boolean
}

function newState(): RedactionState {
  return {
    nodes: 0,
    keys: 0,
    bytes: 0,
    seen: new WeakSet(),
    active: new WeakSet()
  }
}

function normalizeKey(key: string): string {
  return key.trim().replaceAll('_', '-').toLowerCase()
}

/**
 * Returns true for known credentials and future key names that clearly
 * describe a secret. Generic metadata keys such as `envKeys`, `workspaceId`,
 * and `leaseId` intentionally remain visible.
 */
export function isSensitiveLogKey(key: string): boolean {
  const normalized = normalizeKey(key)
  const compact = normalized.replaceAll(/[-_.]/g, '')
  if (EXACT_SAFE_METADATA_KEYS.has(key)) return false
  if (SAFE_METADATA_COMPACT_KEYS.has(compact)) return true
  if (EXACT_SENSITIVE_KEYS.has(normalized) || EXACT_SENSITIVE_KEYS.has(compact)) return true
  return (
    SENSITIVE_KEY_PART.test(normalized) ||
    CAMEL_CASE_SENSITIVE_KEY_PART.test(key) ||
    CONCATENATED_SENSITIVE_KEY.test(compact) ||
    SENSITIVE_IDENTIFIER_KEY.test(normalized) ||
    SENSITIVE_IDENTIFIER_KEY.test(compact)
  )
}

function isValueMapKey(key: string): boolean {
  const compact = key.replaceAll(/[-_.]/g, '').toLowerCase()
  return (
    /^(?:env|envvars|environment|environmentvariables|processenv|authenv|surfaceenv)$/.test(
      compact
    ) ||
    /^(?:header|headers|headermap|headertuples|requestheader|requestheaders|responseheader|responseheaders|httpheader|httpheaders)$/.test(
      compact
    )
  )
}

function isMcpContainerKey(key: string): boolean {
  return /^(?:mcp|mcpconfig|mcpservers?|modelcontextprotocol)$/i.test(key.replaceAll(/[-_.]/g, ''))
}

function isSecretArgFlag(flag: string): boolean {
  if (/^-[ubUcHEpPkt]$/u.test(flag)) return true
  const key = flag.replace(/^--?/, '')
  return (
    isSensitiveLogKey(key) ||
    /^(?:user|proxy-user|header|proxy-header|cookie|cookie-jar|oauth2-bearer|aws-sigv4|cert|proxy-cert|pass|env|environment|headers|mcp-config|mcpconfig)$/i.test(
      key
    )
  )
}

function consumeBytes(state: RedactionState, value: string | number): boolean {
  state.bytes += typeof value === 'number' ? value : Math.min(value.length * 2, MAX_BYTES + 1)
  return state.bytes <= MAX_BYTES
}

function truncate(value: string, max = MAX_OUTPUT_STRING_LENGTH): string {
  return value.length <= max ? value : `${value.slice(0, max)}… [truncated]`
}

function redactUrl(raw: string): string {
  let trailing = ''
  while (/[),.;\]]$/.test(raw)) {
    trailing = raw.slice(-1) + trailing
    raw = raw.slice(0, -1)
  }
  try {
    const url = new URL(raw)
    if (url.username) url.username = REDACTED
    if (url.password) url.password = REDACTED
    for (const key of new Set(url.searchParams.keys())) {
      url.searchParams.set(key, REDACTED)
    }
    if (url.hash) url.hash = REDACTED
    return `${url.toString()}${trailing}`
  } catch {
    return `${REDACTED}${trailing}`
  }
}

function redactUrls(value: string): string {
  return value.replace(URL_VALUE, (url) => redactUrl(url))
}

function redactAssignments(value: string): string {
  return value
    .replace(SIMPLE_SECRET_ASSIGNMENT, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(ASSIGNMENT, (match, prefix: string, key: string) =>
      isSensitiveLogKey(key) ? `${prefix}${REDACTED}` : match
    )
}

function redactArgv(value: string): string {
  const tokens = value.split('\x1f')
  if (tokens.length > 1) {
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]
      const equals = token.indexOf('=')
      const flag = equals >= 0 ? token.slice(0, equals) : token
      if (!flag.startsWith('-') || !isSecretArgFlag(flag)) continue
      if (equals >= 0) {
        tokens[index] = `${flag}=${REDACTED}`
      } else if (index + 1 < tokens.length) {
        tokens[index + 1] = REDACTED
      }
    }
    value = tokens.join('\x1f')
  }

  return value
    .replace(ARGV_PAIR, (match, flag: string, separator: string) =>
      isSecretArgFlag(flag) ? `${flag}${separator}${REDACTED}` : match
    )
    .replace(
      SHORT_SECRET_ARG,
      (_match, prefix: string, flag: string, separator: string | undefined) =>
        `${prefix}${flag}${separator ?? ''}${REDACTED}`
    )
}

function redactMcpConfigArguments(value: string): string {
  return value.replace(MCP_CONFIG_ARGUMENT, (_match, prefix: string) => `${prefix}${REDACTED}`)
}

function redactBoundedString(value: string, state: RedactionState): string {
  const bounded = value.slice(0, MAX_INPUT_STRING_LENGTH)
  if (!consumeBytes(state, bounded)) return BUDGET_EXCEEDED
  const trimmed = bounded.trim()
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return truncate(
        JSON.stringify(redactValue(JSON.parse(trimmed), null, state, 0, { mcp: false }))
      )
    } catch {
      // Fall through to the tolerant text scrubber for malformed JSON/log text.
    }
  }

  const redacted = redactAssignments(redactMcpConfigArguments(redactArgv(redactUrls(bounded))))
    .replace(AUTHORIZATION_VALUE, (match) => `${match.split(/\s+/, 1)[0]} ${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(RECOGNIZABLE_SECRET, REDACTED)
    .replace(PEM_PRIVATE_KEY, REDACTED)
  return truncate(redacted)
}

/** Redacts credentials from already-formatted log text with a pre-parse cap. */
export function redactLogString(value: string): string {
  return redactBoundedString(value, newState())
}

function safePropertyDescriptor(value: object, key: PropertyKey): PropertyDescriptor | null {
  try {
    return Object.getOwnPropertyDescriptor(value, key) ?? null
  } catch {
    return null
  }
}

function boundedOwnStringKeys(value: object, limit: number): string[] | null {
  try {
    const keys: string[] = []
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue
      keys.push(key)
      if (keys.length >= limit) break
    }
    return keys
  } catch {
    return null
  }
}

function boundedArrayLength(value: unknown[]): number | null {
  const descriptor = safePropertyDescriptor(value, 'length')
  return descriptor && 'value' in descriptor && typeof descriptor.value === 'number'
    ? Math.min(Math.max(0, Math.trunc(descriptor.value)), MAX_ARRAY_ITEMS)
    : null
}

function sanitizePropertyName(key: string, state: RedactionState): string {
  if (!consumeBytes(state, key)) return BUDGET_EXCEEDED
  if (isSensitiveLogKey(key)) return '[REDACTED_KEY]'
  return truncate(
    redactAssignments(redactArgv(redactUrls(key)))
      .replace(AUTHORIZATION_VALUE, REDACTED)
      .replace(JWT, REDACTED)
      .replace(RECOGNIZABLE_SECRET, REDACTED),
    MAX_PROPERTY_NAME_LENGTH
  )
}

function setSafeProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  let outputKey = key
  let suffix = 1
  while (Object.prototype.hasOwnProperty.call(target, outputKey)) {
    outputKey = `${key}#${suffix++}`
  }
  Object.defineProperty(target, outputKey, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  })
}

function redactValueMap(value: object, state: RedactionState): unknown {
  if (Array.isArray(value)) {
    const length = boundedArrayLength(value)
    if (length == null) return UNINSPECTABLE
    const result: unknown[] = []
    for (let index = 0; index < length; index++) {
      const descriptor = safePropertyDescriptor(value, String(index))
      if (!descriptor || !('value' in descriptor)) {
        result.push(ACCESSOR)
        continue
      }
      const item: unknown = descriptor.value
      if (Array.isArray(item)) {
        const tupleName = safePropertyDescriptor(item, '0')
        const name: unknown = tupleName && 'value' in tupleName ? tupleName.value : 'header'
        result.push([
          typeof name === 'string' ? sanitizePropertyName(name, state) : '[KEY]',
          REDACTED
        ])
      } else {
        result.push(REDACTED)
      }
    }
    return result
  }

  const keys = boundedOwnStringKeys(value, Math.max(0, MAX_KEYS - state.keys))
  if (keys == null) return UNINSPECTABLE
  const result = Object.create(null) as Record<string, unknown>
  for (const key of keys) {
    state.keys++
    setSafeProperty(result, sanitizePropertyName(key, state), REDACTED)
  }
  return result
}

function redactArray(
  value: unknown[],
  state: RedactionState,
  depth: number,
  context: RedactionContext
): unknown[] | string {
  const length = boundedArrayLength(value)
  if (length == null) return UNINSPECTABLE
  const result: unknown[] = []
  for (let index = 0; index < length; index++) {
    const descriptor = safePropertyDescriptor(value, String(index))
    result.push(
      descriptor && 'value' in descriptor
        ? redactValue(descriptor.value, null, state, depth + 1, context)
        : ACCESSOR
    )
  }
  const rawLength = safePropertyDescriptor(value, 'length')
  if (rawLength && 'value' in rawLength && rawLength.value > length) {
    result.push('[ARRAY_TRUNCATED]')
  }
  return result
}

function redactMap(
  value: Map<unknown, unknown>,
  state: RedactionState,
  depth: number,
  context: RedactionContext
): Record<string, unknown> | string {
  const result = Object.create(null) as Record<string, unknown>
  try {
    let count = 0
    const entries = Map.prototype.entries.call(value) as MapIterator<[unknown, unknown]>
    for (const [key, child] of entries) {
      if (count++ >= MAX_ARRAY_ITEMS || state.keys++ >= MAX_KEYS) break
      const keyString = typeof key === 'string' ? key : null
      const outputKey = keyString
        ? sanitizePropertyName(keyString, state)
        : `[map-key-${count}:${typeof key}]`
      setSafeProperty(
        result,
        outputKey,
        keyString != null && isSensitiveLogKey(keyString)
          ? REDACTED
          : redactValue(child, keyString, state, depth + 1, context)
      )
    }
    return result
  } catch {
    return UNINSPECTABLE
  }
}

function redactSet(
  value: Set<unknown>,
  state: RedactionState,
  depth: number,
  context: RedactionContext
): unknown[] | string {
  try {
    const result: unknown[] = []
    const values = Set.prototype.values.call(value) as SetIterator<unknown>
    for (const item of values) {
      if (result.length >= MAX_ARRAY_ITEMS) break
      result.push(redactValue(item, null, state, depth + 1, context))
    }
    return result
  } catch {
    return UNINSPECTABLE
  }
}

function redactPlainObject(
  value: object,
  state: RedactionState,
  depth: number,
  context: RedactionContext
): Record<string, unknown> | string {
  const keys = boundedOwnStringKeys(value, Math.max(0, MAX_KEYS - state.keys))
  if (keys == null) return UNINSPECTABLE
  const result = Object.create(null) as Record<string, unknown>
  for (const key of keys) {
    if (state.keys++ >= MAX_KEYS) {
      setSafeProperty(result, '[KEYS_TRUNCATED]', BUDGET_EXCEEDED)
      break
    }
    const outputKey = sanitizePropertyName(key, state)
    const childContext = { mcp: context.mcp || isMcpContainerKey(key) }
    let child: unknown = ACCESSOR
    const descriptor = safePropertyDescriptor(value, key)
    if (descriptor && 'value' in descriptor) {
      const descriptorValue: unknown = descriptor.value
      if (childContext.mcp && /^args$/i.test(key) && Array.isArray(descriptorValue)) {
        const length = boundedArrayLength(descriptorValue)
        child = length == null ? UNINSPECTABLE : Array.from({ length }, () => REDACTED)
      } else {
        child = redactValue(descriptorValue, key, state, depth + 1, childContext)
      }
    }
    setSafeProperty(result, outputKey, child)
  }
  return result
}

function redactObject(
  value: object,
  state: RedactionState,
  depth: number,
  context: RedactionContext
): unknown {
  if (state.active.has(value)) return CIRCULAR
  if (state.seen.has(value)) return REFERENCE
  if (depth >= MAX_DEPTH || state.nodes++ >= MAX_NODES) return BUDGET_EXCEEDED
  state.seen.add(value)
  state.active.add(value)
  try {
    if (ArrayBuffer.isView(value)) {
      const byteLength =
        'byteLength' in value && typeof value.byteLength === 'number' ? value.byteLength : 0
      consumeBytes(state, byteLength)
      return `[Binary view ${byteLength} bytes]`
    }
    if (value instanceof ArrayBuffer) {
      consumeBytes(state, value.byteLength)
      return `[ArrayBuffer ${value.byteLength} bytes]`
    }
    if (value instanceof Date) {
      try {
        const time = Date.prototype.getTime.call(value)
        return Number.isFinite(time) ? new Date(time).toISOString() : '[Invalid Date]'
      } catch {
        return UNINSPECTABLE
      }
    }
    if (value instanceof Error) {
      const descriptorString = (key: string, fallback: string): string => {
        const descriptor = safePropertyDescriptor(value, key)
        const descriptorValue: unknown =
          descriptor && 'value' in descriptor ? descriptor.value : fallback
        return typeof descriptorValue === 'string' ? descriptorValue : fallback
      }
      const cause = safePropertyDescriptor(value, 'cause')
      return {
        name: redactBoundedString(descriptorString('name', 'Error'), state),
        message: redactBoundedString(descriptorString('message', ''), state),
        ...(descriptorString('stack', '')
          ? { stack: redactBoundedString(descriptorString('stack', ''), state) }
          : {}),
        ...(cause && 'value' in cause
          ? { cause: redactValue(cause.value, 'cause', state, depth + 1, context) }
          : {})
      }
    }
    if (Array.isArray(value)) return redactArray(value, state, depth, context)
    if (value instanceof Map) return redactMap(value, state, depth, context)
    if (value instanceof Set) return redactSet(value, state, depth, context)
    return redactPlainObject(value, state, depth, context)
  } catch {
    return UNINSPECTABLE
  } finally {
    state.active.delete(value)
  }
}

function redactValue(
  value: unknown,
  key: string | null,
  state: RedactionState,
  depth: number,
  context: RedactionContext
): unknown {
  if (key != null && isSensitiveLogKey(key)) return REDACTED
  if (key != null && isMcpContainerKey(key) && typeof value === 'string') return REDACTED
  if (key != null && isValueMapKey(key)) {
    return value != null && typeof value === 'object' ? redactValueMap(value, state) : REDACTED
  }
  if (typeof value === 'string') return redactBoundedString(value, state)
  if (value == null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : '[NON_FINITE_NUMBER]'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'object') return redactObject(value, state, depth, context)
  return `[${typeof value}]`
}

/** Recursively creates a bounded, plain-JSON logging-safe copy. */
export function redactLogValue(value: unknown): unknown {
  return redactValue(value, null, newState(), 0, { mcp: false })
}

export function redactLogRecord(
  value: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (value == null) return null
  const redacted = redactLogValue(value)
  return redacted != null && typeof redacted === 'object' && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : { value: redacted }
}

export function redactErrorForLog(error: unknown): unknown {
  return redactLogValue(error)
}

export function redactErrorMessage(error: unknown): string {
  if (error instanceof Error) return redactLogString(error.message)
  return redactLogString(String(error))
}

export const LOG_REDACTED_VALUE = REDACTED
